//! User themes live as one JSON file each in `~/.rally/themes/<id>.json`, so
//! they survive reinstalls and can be shared or edited by hand. The frontend
//! owns the schema; Rust only validates the id and moves bytes.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn themes_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let dir = PathBuf::from(home).join(".rally").join("themes");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Ids become file names: lowercase letters, digits and dashes only, so an id
/// can never escape the themes directory.
fn theme_path(id: &str) -> Result<PathBuf, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("invalid theme id: {id:?}"));
    }
    Ok(themes_dir()?.join(format!("{id}.json")))
}

fn images_dir() -> Result<PathBuf, String> {
    let dir = themes_dir()?.join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Copy a picked image into `~/.rally/themes/images` (the only folder the
/// asset protocol may read) and return its file name. Themes store the name,
/// so they keep working if the original file moves.
#[tauri::command]
pub fn import_theme_image(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .ok_or_else(|| format!("not a supported image (png, jpg, webp, gif): {path}"))?;
    let stem: String = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{}-{stamp}.{ext}", if stem.is_empty() { "image" } else { &stem[..stem.len().min(40)] });
    let dest = images_dir()?.join(&name);
    fs::copy(&src, &dest).map_err(|e| format!("copy {} -> {}: {}", src.display(), dest.display(), e))?;
    Ok(name)
}

#[tauri::command]
pub fn theme_images_dir_path() -> Result<String, String> {
    Ok(images_dir()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn themes_dir_path() -> Result<String, String> {
    Ok(themes_dir()?.to_string_lossy().into_owned())
}

/// Every parseable theme file. A broken file is reported and skipped so one
/// bad hand edit can't hide the rest.
#[tauri::command]
pub fn list_themes() -> Result<Vec<Value>, String> {
    let dir = themes_dir()?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("read {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| {
            serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())
        }) {
            Ok(v) => out.push(v),
            Err(e) => eprintln!("[rally] skipping theme {}: {e}", path.display()),
        }
    }
    Ok(out)
}

/// Write atomically (temp file + rename) so a crash mid-save never leaves a
/// truncated theme behind.
#[tauri::command]
pub fn save_theme(theme: Value) -> Result<(), String> {
    let id = theme
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("theme has no id")?;
    let path = theme_path(id)?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(&theme).map_err(|e| e.to_string())?;
    fs::write(&tmp, data).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {}", path.display(), e))
}

#[tauri::command]
pub fn delete_theme(id: String) -> Result<(), String> {
    let path = theme_path(&id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {}", path.display(), e)),
    }
}

/// Installed font families, for the font pickers. AppKit is main-thread only;
/// sync commands run there.
#[tauri::command]
pub fn list_font_families() -> Result<Vec<String>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSFontManager;

    let mtm = MainThreadMarker::new().ok_or("list_font_families: not on main thread")?;
    let manager = NSFontManager::sharedFontManager(mtm);
    let families = manager.availableFontFamilies();
    let mut out: Vec<String> = (0..families.len())
        .map(|i| families.objectAtIndex(i).to_string())
        .filter(|name| !name.starts_with('.'))
        .collect();
    out.sort_by_key(|s| s.to_lowercase());
    Ok(out)
}
