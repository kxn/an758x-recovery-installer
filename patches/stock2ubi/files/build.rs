use std::env;
use std::fs;
use std::path::PathBuf;

/// Build-time injection for the wizard image.
///
/// When `WIZARD_TARGET` is set, the build embeds the paired U-Boot images,
/// their hashes, the board-data spec and the shared wizard JavaScript, and
/// the resulting binary exposes the one-click wizard API. Without it the
/// crate still builds as the plain manual tool (no embedded images).
///
/// Image paths are copied into OUT_DIR so `include_bytes!` has stable paths.
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in padded.chunks_exact(64) {
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

/// One board-data line: source_kind|name1,name2|target_volume|target_size
/// Lines are separated by `;`. Names are escaped with \xHH-free plain text;
/// build.sh generates them from the profile + extracted DTB layout.
fn parse_specs(specs: &str) -> Vec<String> {
    specs
        .split(';')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('|').collect();
            if fields.len() != 4 {
                panic!("invalid WIZARD_BOARD_SPECS line: {line}");
            }
            let kind = fields[0].trim();
            let names: Vec<&str> = fields[1].split(',').map(str::trim).collect();
            let volume = fields[2].trim();
            let size = fields[3]
                .trim()
                .parse::<u64>()
                .unwrap_or_else(|_| panic!("invalid target size in: {line}"));
            let names_lit = names
                .iter()
                .map(|name| format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "    BoardSpec {{ source_kind: \"{kind}\", source_names: &[{names_lit}], \
                 target_volume: \"{volume}\", target_size: {size} }},"
            )
        })
        .collect()
}

fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn manual_meta_json() -> String {
    r#"{"embedded":false}"#.to_string()
}

fn main() {
    for var in [
        "WIZARD_TARGET",
        "WIZARD_UBOOT_MODEL",
        "WIZARD_BOOT_IMAGE_KIND",
        "WIZARD_UBOOT_COMMIT",
        "WIZARD_STOCK_COMMIT",
        "WIZARD_VERSION",
        "WIZARD_STOCK_HINTS",
        "WIZARD_BOARD_SPECS",
        "WIZARD_BL2_PATH",
        "WIZARD_FIP_PATH",
        "WIZARD_JS_PATH",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));

    let manual = r#"
pub const EMBEDDED: bool = false;
pub const TARGET: &str = "";
pub const UBOOT_MODEL: &str = "";
pub const BOOT_IMAGE_KIND: &str = "";
pub const UBOOT_COMMIT: &str = "";
pub const STOCK_COMMIT: &str = "";
pub const WIZARD_VERSION: &str = "";
pub const STOCK_HINTS: &[&str] = &[];
pub const BL2: &[u8] = &[];
pub const FIP: &[u8] = &[];
pub const BL2_SHA256: &str = "";
pub const FIP_SHA256: &str = "";
pub const WIZARD_JS: &str = "";
pub const WIZARD_STOCK_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/wizard-stock.js"));
#[derive(Debug, Clone, Copy)]
pub struct BoardSpec {
    pub source_kind: &'static str,
    pub source_names: &'static [&'static str],
    pub target_volume: &'static str,
    pub target_size: u64,
}
pub static BOARD_DATA: &[BoardSpec] = &[];
"#;

    let Ok(target) = env::var("WIZARD_TARGET") else {
        fs::write(out_dir.join("wizard_meta.rs"), manual).unwrap();
        fs::write(out_dir.join("wizard_meta.json"), manual_meta_json()).unwrap();
        return;
    };
    if target.is_empty() {
        fs::write(out_dir.join("wizard_meta.rs"), manual).unwrap();
        fs::write(out_dir.join("wizard_meta.json"), manual_meta_json()).unwrap();
        return;
    }

    let require = |name: &str| -> String {
        env::var(name).unwrap_or_else(|_| panic!("{name} is required when WIZARD_TARGET is set"))
    };
    let uboot_model = require("WIZARD_UBOOT_MODEL");
    let boot_image_kind = require("WIZARD_BOOT_IMAGE_KIND");
    let uboot_commit = require("WIZARD_UBOOT_COMMIT");
    let stock_commit = require("WIZARD_STOCK_COMMIT");
    let version = require("WIZARD_VERSION");
    let hints = env::var("WIZARD_STOCK_HINTS").unwrap_or_default();
    let specs = env::var("WIZARD_BOARD_SPECS").unwrap_or_default();
    let bl2_path = require("WIZARD_BL2_PATH");
    let fip_path = require("WIZARD_FIP_PATH");
    let js_path = env::var("WIZARD_JS_PATH").unwrap_or_default();

    if boot_image_kind != "preloader" && boot_image_kind != "firstblock" {
        panic!("WIZARD_BOOT_IMAGE_KIND must be preloader or firstblock");
    }

    let bl2 = fs::read(&bl2_path).unwrap_or_else(|e| panic!("reading BL2 {bl2_path}: {e}"));
    let fip = fs::read(&fip_path).unwrap_or_else(|e| panic!("reading FIP {fip_path}: {e}"));
    if bl2.is_empty() || fip.is_empty() {
        panic!("embedded images must not be empty");
    }
    fs::write(out_dir.join("bl2.bin"), &bl2).unwrap();
    fs::write(out_dir.join("fip.bin"), &fip).unwrap();

    let js = if js_path.is_empty() {
        String::new()
    } else {
        fs::read_to_string(&js_path).unwrap_or_else(|e| panic!("reading wizard JS {js_path}: {e}"))
    };
    if js.contains("</script") {
        panic!("wizard JS contains </script> and cannot be inlined into index.html");
    }
    fs::write(out_dir.join("wizard-js.js"), &js).unwrap();

    // The stock page script is inlined into index.html at render time via
    // wizard::WIZARD_STOCK_JS; stash it in OUT_DIR for include_str!.
    let stock_js = fs::read_to_string("src/wizard-stock.js")
        .unwrap_or_else(|e| panic!("reading src/wizard-stock.js: {e}"));
    if stock_js.contains("</script") {
        panic!("src/wizard-stock.js contains </script> and cannot be inlined");
    }
    fs::write(out_dir.join("wizard-stock.js"), &stock_js).unwrap();

    let bl2_sha = sha256(&bl2);
    let fip_sha = sha256(&fip);
    let hints_lit = hints
        .split(',')
        .filter(|hint| !hint.trim().is_empty())
        .map(|hint| {
            format!(
                "\"{}\"",
                hint.trim().replace('\\', "\\\\").replace('"', "\\\"")
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let board_lit = parse_specs(&specs).join("\n");

    let embedded = format!(
        r#"
pub const EMBEDDED: bool = true;
pub const TARGET: &str = "{target}";
pub const UBOOT_MODEL: &str = "{uboot_model}";
pub const BOOT_IMAGE_KIND: &str = "{boot_image_kind}";
pub const UBOOT_COMMIT: &str = "{uboot_commit}";
pub const STOCK_COMMIT: &str = "{stock_commit}";
pub const WIZARD_VERSION: &str = "{version}";
pub const STOCK_HINTS: &[&str] = &[{hints_lit}];
pub const BL2: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/bl2.bin"));
pub const FIP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/fip.bin"));
pub const BL2_SHA256: &str = "{bl2_sha}";
pub const FIP_SHA256: &str = "{fip_sha}";
pub const WIZARD_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/wizard-js.js"));
pub const WIZARD_STOCK_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/wizard-stock.js"));
#[derive(Debug, Clone, Copy)]
pub struct BoardSpec {{
    pub source_kind: &'static str,
    pub source_names: &'static [&'static str],
    pub target_volume: &'static str,
    pub target_size: u64,
}}
pub static BOARD_DATA: &[BoardSpec] = &[
{board_lit}
];
"#
    );
    fs::write(out_dir.join("wizard_meta.rs"), embedded).unwrap();

    // META_JSON: everything /api/wizard serves that does not depend on the
    // runtime device (build metadata, hashes, board spec). The JS bundle is
    // referenced by hash so the page can verify it before use.
    let js_sha = sha256(js.as_bytes());
    let board_json = specs
        .split(';')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('|').collect();
            if fields.len() != 4 {
                panic!("invalid WIZARD_BOARD_SPECS line: {line}");
            }
            let kind = json_escape(fields[0].trim());
            let names: Vec<String> = fields[1]
                .split(',')
                .map(|name| format!("\"{}\"", json_escape(name.trim())))
                .collect();
            let volume = json_escape(fields[2].trim());
            let size = fields[3]
                .trim()
                .parse::<u64>()
                .unwrap_or_else(|_| panic!("invalid target size in: {line}"));
            format!(
                "{{\"source_kind\":\"{kind}\",\"source_names\":[{}],\"target_volume\":\"{volume}\",\"target_size\":{size}}}",
                names.join(",")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let hints_json = hints
        .split(',')
        .filter(|hint| !hint.trim().is_empty())
        .map(|hint| format!("\"{}\"", json_escape(hint.trim())))
        .collect::<Vec<_>>()
        .join(",");
    let meta_json = format!(
        concat!(
            r#"{{"embedded":true,"target":"{}","uboot_model":"{}","boot_image_kind":"{}","#,
            r#""uboot_commit":"{}","stock_commit":"{}","version":"{}","#,
            r#""stock_hints":[{}],"bl2":{{"size":{},"sha256":"{}"}},"#,
            r#""fip":{{"size":{},"sha256":"{}"}},"board_data":[{}],"#,
            r#""wizard_js_sha256":"{}"}}"#
        ),
        json_escape(&target),
        json_escape(&uboot_model),
        json_escape(&boot_image_kind),
        json_escape(&uboot_commit),
        json_escape(&stock_commit),
        json_escape(&version),
        hints_json,
        bl2.len(),
        json_escape(&bl2_sha),
        fip.len(),
        json_escape(&fip_sha),
        board_json,
        json_escape(&js_sha),
    );
    fs::write(out_dir.join("wizard_meta.json"), meta_json).unwrap();
}
