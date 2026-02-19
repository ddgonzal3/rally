#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};

use claude_workbench::commands;
use claude_workbench::config_ops;
use claude_workbench::pty_manager::{self, PtyManager};

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::create_workspace,
            commands::remove_workspace,
            commands::git_status,
            commands::git_sync,
            commands::git_rebase,
            commands::git_commit,
            commands::git_push,
            commands::git_create_pr,
            commands::list_directory,
            commands::detect_git_info,
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::kill_pty,
            pty_manager::list_ptys,
            config_ops::read_file_content,
            config_ops::write_file_content,
            config_ops::list_claude_configs,
            config_ops::list_skills,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
