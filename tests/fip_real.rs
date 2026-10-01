//! Validate the real signed artifacts from a paired build against the exact
//! parsers the flashing path uses. Set REAL_FIP/REAL_PRELOADER to run.
use an758x_stock2ubi::fip;

fn load(name: &str) -> Vec<u8> {
    std::fs::read(std::env::var(name).expect(name)).expect("artifact missing")
}

fn require_artifacts() -> bool {
    std::env::var("REAL_FIP").is_ok() && std::env::var("REAL_PRELOADER").is_ok()
}

#[test]
fn real_signed_fip_has_bl31_and_bl33() {
    if !require_artifacts() {
        return;
    }
    fip::validate_bl31_uboot(&load("REAL_FIP")).unwrap();
}

#[test]
fn real_signed_preloader_has_tb_fw() {
    if !require_artifacts() {
        return;
    }
    fip::validate_preloader(&load("REAL_PRELOADER")).unwrap();
}

#[test]
fn real_preloader_prepares_a_first_block() {
    if !require_artifacts() {
        return;
    }
    let preloader = load("REAL_PRELOADER");
    let current = vec![0x5a; 0x20000];
    let block = fip::prepare_first_block(&preloader, &current, 0x20000).unwrap();
    assert_eq!(&block[..0x800], &current[..0x800]);
    assert_eq!(&block[0x800..0x800 + preloader.len()], &preloader);
}

#[test]
fn real_fip_fits_the_uboot_fip_volume() {
    if !require_artifacts() {
        return;
    }
    // Web U-Boot's fip volume capacity is 0x100000 (create_recovery_layout).
    assert!(load("REAL_FIP").len() < 0x100000);
}

#[test]
fn embedded_images_are_byte_identical_to_the_release_files() {
    // Only meaningful in an embedded build; the manual build embeds nothing.
    if !an758x_stock2ubi::wizard::EMBEDDED || !require_artifacts() {
        return;
    }
    use an758x_stock2ubi::wizard;
    assert_eq!(wizard::FIP, load("REAL_FIP").as_slice());
    assert_eq!(wizard::BL2, load("REAL_PRELOADER").as_slice());
}
