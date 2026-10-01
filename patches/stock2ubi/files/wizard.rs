//! Build-injected wizard metadata and embedded images (see build.rs).

include!(concat!(env!("OUT_DIR"), "/wizard_meta.rs"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_build_has_no_images() {
        if !EMBEDDED {
            assert!(BL2.is_empty());
            assert!(FIP.is_empty());
            assert!(BOARD_DATA.is_empty());
        }
    }
}
