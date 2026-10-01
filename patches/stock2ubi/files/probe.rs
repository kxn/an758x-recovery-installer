//! Best-effort stock-device probing for the wizard.
//!
//! Reads kernel release, device-tree model and the MTD table, then compares
//! the observable device against the embedded board-data spec:
//!
//! - `Match`: every spec line resolved to exactly one MTD partition, free of
//!   bad blocks, long enough for the target volume, and (when readable) the
//!   DTB model matches a stock hint.
//! - `Partial`: evidence is missing or unusable (unknown model, missing
//!   source partition, bad blocks). The page shows target and evidence for
//!   manual confirmation instead of one-click.
//! - `Conflict`: an obtained value clearly rules the target out (model
//!   readable but matches no hint, duplicate source names, source partition
//!   shorter than the target volume). The one-click entry point refuses to
//!   run.
//!
//! Nothing here writes to the device; flashing stays in `install::flash`.

use crate::mtd::{self, Partition};
use an758x_stock2ubi::wizard::{self, BoardSpec};

#[derive(Debug, Clone)]
pub struct MtdEvidence {
    pub index: u32,
    pub name: String,
    pub size: u64,
    pub erase_size: u64,
    pub offset: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct FoundSpec {
    pub target_volume: String,
    pub source_names: Vec<String>,
    pub mtd_index: Option<u32>,
    pub mtd_name: Option<String>,
    /// Bytes the page must download: the whole partition, as /backup/{index}
    /// streams the full MTD. Must equal /proc/mtd's declared size.
    pub read_length: Option<u64>,
    pub size_ok: bool,
    pub bad_blocks: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Probe {
    pub kind: MatchKind,
    /// One-click flashing is offered only when every board-data source was
    /// resolved, is free of bad blocks and its partition size exactly equals
    /// the target volume size.
    pub auto_ok: bool,
    pub kernel_release: Option<String>,
    pub dtb_model: Option<String>,
    pub mtd: Vec<MtdEvidence>,
    pub found: Vec<FoundSpec>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    Match,
    Partial,
    Conflict,
}

impl MatchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchKind::Match => "match",
            MatchKind::Partial => "partial",
            MatchKind::Conflict => "conflict",
        }
    }
}

fn read_kernel_release() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn read_dtb_model() -> Option<String> {
    let candidates = [
        "/proc/device-tree/model",
        "/sys/firmware/devicetree/base/model",
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim_matches('\0').trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn model_matches_hints(model: &str, hints: &[&str]) -> bool {
    if hints.is_empty() {
        return false;
    }
    let model = model.to_lowercase();
    hints
        .iter()
        .any(|hint| !hint.is_empty() && model.contains(&hint.to_lowercase()))
}

/// Decide the kind contribution of the device-tree model (PLAN section 3):
/// a readable model that matches no hint is a Conflict, a matching model is a
/// Match, and an unreadable model is neither — missing evidence must not
/// block an otherwise fully confirmed device.
fn model_kind(model: Option<&str>, hints: &[&str]) -> MatchKind {
    match model {
        Some(model) if !model_matches_hints(model, hints) => MatchKind::Conflict,
        Some(_) => MatchKind::Match,
        None => MatchKind::Match,
    }
}

/// Count bad eraseblocks in the partition by walking the block table.
fn count_bad_blocks(partition: &Partition) -> Option<u64> {
    let device = mtd::MtdDevice::open(partition.clone()).ok()?;
    let mut bad = 0u64;
    let mut offset = 0u64;
    while offset < partition.size {
        match device.is_bad(offset) {
            Ok(true) => bad += 1,
            Ok(false) => {}
            Err(_) => return None,
        }
        offset += device.erase_size.max(1);
    }
    Some(bad)
}

fn find_source(
    spec: &BoardSpec,
    partitions: &[Partition],
    found: &mut FoundSpec,
    reasons: &mut Vec<String>,
) -> MatchKind {
    let mut candidates: Vec<&Partition> = partitions
        .iter()
        .filter(|partition| spec.source_names.contains(&partition.name.as_str()))
        .collect();

    if candidates.len() > 1 {
        reasons.push(format!(
            "{}: multiple MTD partitions named {:?}",
            spec.target_volume, spec.source_names
        ));
        return MatchKind::Conflict;
    }
    let Some(partition) = candidates.pop() else {
        reasons.push(format!(
            "{}: no MTD partition named {:?}",
            spec.target_volume, spec.source_names
        ));
        return MatchKind::Partial;
    };
    if partition.size < spec.target_size {
        reasons.push(format!(
            "{}: partition {} is {} bytes, shorter than target volume {} bytes",
            spec.target_volume, partition.name, partition.size, spec.target_size
        ));
        return MatchKind::Conflict;
    }
    if partition.size != spec.target_size {
        // Downloadable, but the byte count does not match the U-Boot board
        // data size; the restore side would reject it, so auto-flash stays off.
        reasons.push(format!(
            "{}: partition {} is {} bytes, not the {} bytes the target volume needs",
            spec.target_volume, partition.name, partition.size, spec.target_size
        ));
        found.mtd_index = Some(partition.index);
        found.mtd_name = Some(partition.name.clone());
        found.read_length = Some(partition.size);
        found.size_ok = false;
        found.bad_blocks = None;
        return MatchKind::Partial;
    }

    found.mtd_index = Some(partition.index);
    found.mtd_name = Some(partition.name.clone());
    found.read_length = Some(partition.size);
    found.size_ok = true;
    found.bad_blocks = count_bad_blocks(partition);
    match found.bad_blocks {
        Some(0) => MatchKind::Match,
        Some(bad) => {
            reasons.push(format!(
                "{}: source partition {} has {bad} bad block(s)",
                spec.target_volume, partition.name
            ));
            MatchKind::Partial
        }
        None => {
            reasons.push(format!(
                "{}: bad-block table of {} could not be read",
                spec.target_volume, partition.name
            ));
            MatchKind::Partial
        }
    }
}

pub fn run() -> Probe {
    let mut probe = Probe {
        kind: MatchKind::Partial,
        auto_ok: false,
        kernel_release: read_kernel_release(),
        dtb_model: read_dtb_model(),
        mtd: Vec::new(),
        found: Vec::new(),
        reasons: Vec::new(),
    };

    if !wizard::EMBEDDED {
        probe
            .reasons
            .push("binary was built without embedded images".to_string());
        return probe;
    }

    let partitions = match mtd::discover_partitions() {
        Ok(partitions) => partitions,
        Err(error) => {
            probe
                .reasons
                .push(format!("reading MTD table failed: {error}"));
            return probe;
        }
    };
    probe.mtd = partitions
        .iter()
        .map(|partition| MtdEvidence {
            index: partition.index,
            name: partition.name.clone(),
            size: partition.size,
            erase_size: partition.erase_size,
            offset: partition.offset,
        })
        .collect();

    let mut kind = MatchKind::Match;
    let mut seen_indices: Vec<u32> = Vec::new();
    for spec in wizard::BOARD_DATA {
        let mut found = FoundSpec {
            target_volume: spec.target_volume.to_string(),
            source_names: spec
                .source_names
                .iter()
                .map(|name| name.to_string())
                .collect(),
            mtd_index: None,
            mtd_name: None,
            read_length: None,
            size_ok: false,
            bad_blocks: None,
        };
        let line = find_source(spec, &partitions, &mut found, &mut probe.reasons);
        if line == MatchKind::Conflict {
            kind = MatchKind::Conflict;
        } else if line == MatchKind::Partial && kind == MatchKind::Match {
            kind = MatchKind::Partial;
        }
        // Two board-data entries resolving to the same MTD partition would
        // silently copy one partition's bytes into two different target
        // volumes; treat that as a conflict.
        if let Some(index) = found.mtd_index {
            if seen_indices.contains(&index) {
                probe.reasons.push(format!(
                    "{}: MTD partition {index} is already used by another board-data entry",
                    spec.target_volume
                ));
                kind = MatchKind::Conflict;
            } else {
                seen_indices.push(index);
            }
        }
        probe.found.push(found);
    }

    if kind == MatchKind::Match {
        match model_kind(probe.dtb_model.as_deref(), wizard::STOCK_HINTS) {
            MatchKind::Conflict => {
                probe.reasons.push(format!(
                    "device model {:?} matches no stock hint",
                    probe.dtb_model.as_deref().unwrap_or_default()
                ));
                kind = MatchKind::Conflict;
            }
            MatchKind::Match => {
                if probe.dtb_model.is_none() {
                    probe.reasons.push(
                        "device-tree model is not readable; please confirm the model manually"
                            .to_string(),
                    );
                }
            }
            MatchKind::Partial => unreachable!("model_kind never returns Partial"),
        }
    }

    probe.auto_ok = kind == MatchKind::Match
        && !wizard::BOARD_DATA.is_empty()
        && probe
            .found
            .iter()
            .all(|found| found.mtd_index.is_some() && found.size_ok && found.bad_blocks == Some(0));
    probe.kind = kind;
    probe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_matching_uses_substring_insensitively() {
        let hints: &[&str] = &["XG-040G-MD"];
        assert!(model_matches_hints("Nokia XG-040G-MD", hints));
        assert!(model_matches_hints("nokia xg-040g-md", hints));
        assert!(!model_matches_hints("Nokia XG-040G-TF", hints));
        assert!(!model_matches_hints("anything", &[]));
    }

    #[test]
    fn unreadable_model_does_not_deny_the_match() {
        // The MF device's stock system may not expose /proc/device-tree/model;
        // that missing evidence must not block an otherwise confirmed device.
        let hints: &[&str] = &["XG-040G-MF"];
        assert_eq!(model_kind(None, hints), MatchKind::Match);
        assert_eq!(
            model_kind(Some("Nokia XG-040G-MF"), hints),
            MatchKind::Match
        );
        assert_eq!(
            model_kind(Some("Nokia XG-040G-MD"), hints),
            MatchKind::Conflict
        );
    }

    #[test]
    fn manual_build_probe_reports_manual() {
        if !wizard::EMBEDDED {
            let probe = run();
            assert_eq!(probe.kind, MatchKind::Partial);
            assert!(!probe.auto_ok);
        }
    }
}
