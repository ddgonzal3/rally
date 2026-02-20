#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};

use playbench::commands;
use playbench::config_ops;
use playbench::pty_manager::{self, PtyManager};
use tauri::Manager;

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::create_workspace,
            commands::remove_workspace,
            commands::add_workspace_path,
            commands::remove_workspace_path,
            commands::git_status,
            commands::git_sync,
            commands::git_rebase,
            commands::git_commit,
            commands::git_push,
            commands::git_create_pr,
            commands::git_pr_status,
            commands::git_merge_pr,
            commands::git_changes,
            commands::git_file_at_head,
            commands::git_stage_file,
            commands::git_unstage_file,
            commands::list_directory,
            commands::detect_git_info,
            commands::list_curated_files,
            commands::reveal_in_finder,
            commands::list_tasks,
            commands::sync_claude_commands,
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::kill_pty,
            pty_manager::list_ptys,
            config_ops::read_file_content,
            config_ops::read_file_base64,
            config_ops::write_file_content,
            config_ops::list_claude_configs,
            config_ops::list_skills,
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            // Position window on the largest monitor's left half
            if let Ok(monitors) = win.available_monitors() {
                // Pick the monitor with the largest width (likely the widescreen)
                if let Some(monitor) = monitors.iter().max_by_key(|m| m.size().width) {
                    let pos = monitor.position();
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let half_w = (size.width as f64 / scale / 2.0) as f64;
                    let h = (size.height as f64 / scale) as f64;
                    let x = pos.x as f64 / scale;
                    let y = pos.y as f64 / scale;
                    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
                    let _ = win.set_size(tauri::LogicalSize::new(half_w, h));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
