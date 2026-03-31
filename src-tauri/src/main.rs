#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rally::commands;
use rally::config_ops;
use rally::git_watch::GitWatchState;
use rally::pty_manager::{self, PtyManager};
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Whether we're running in test mode (RALLY_TEST_MODE=1).
fn is_test_mode() -> bool {
    std::env::var("RALLY_TEST_MODE").is_ok()
}

/// Show the native "Close Window?" confirmation dialog for secondary windows.
fn show_close_window_dialog(
    window: tauri::Window,
    close_window_showing: Arc<AtomicBool>,
    bypass_close_confirm: Arc<Mutex<HashSet<String>>>,
) {
    if close_window_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = close_window_showing.clone();
    let label = window.label().to_string();
    window
        .app_handle()
        .dialog()
        .message("Are you sure you want to close this window?")
        .title("Close Window")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            s.store(false, Ordering::SeqCst);
            if !confirmed {
                return;
            }

            if let Ok(mut bypass) = bypass_close_confirm.lock() {
                bypass.insert(label.clone());
            } else {
                eprintln!("Failed to lock close-window bypass set");
                return;
            }

            if let Err(e) = window.close() {
                eprintln!("Failed to close window {}: {}", label, e);
                if let Ok(mut bypass) = bypass_close_confirm.lock() {
                    bypass.remove(&label);
                }
            }
        });
}

/// Show the native "Quit Rally?" confirmation dialog on a best-effort parent window.
fn show_quit_dialog(app: tauri::AppHandle, quit_showing: Arc<AtomicBool>) {
    // Don't stack dialogs
    if quit_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = quit_showing.clone();
    let parent_window = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next());

    if let Some(window) = parent_window {
        window
            .app_handle()
            .dialog()
            .message("Are you sure you want to quit Rally?")
            .title("Quit Rally")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ))
            .show(move |confirmed| {
                s.store(false, Ordering::SeqCst);
                if confirmed {
                    app.exit(0);
                }
            });
    } else {
        s.store(false, Ordering::SeqCst);
        app.exit(0);
    }
}

/// Emit an app event to the focused window only (falls back to app-wide emit
/// if focus can't be resolved).
fn emit_to_focused_window(app: &tauri::AppHandle, event: &str) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));

    if let Some(win) = focused {
        if let Err(e) = win.emit(event, ()) {
            eprintln!("Failed to emit {} to focused window: {}", event, e);
        }
    } else if let Err(e) = app.emit(event, ()) {
        eprintln!("Failed to emit {} app-wide: {}", event, e);
    }
}

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));
    let pty_exit = pty_state.clone();
    let git_watch_state = GitWatchState::default();
    // Guard to prevent stacking multiple quit dialogs
    let quit_showing = Arc::new(AtomicBool::new(false));
    // Guard to prevent stacking close-window dialogs
    let close_window_showing = Arc::new(AtomicBool::new(false));
    // Window labels that are allowed to bypass close confirmation once.
    let bypass_close_confirm: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty_state)
        .manage(git_watch_state);

    // In test-bridge mode, create the shared result channels.
    #[cfg(feature = "test-bridge")]
    let test_bridge_pending: rally::test_server::ResultSenders =
        std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_workspaces,
        commands::update_git_watch_roots,
        commands::create_workspace,
        commands::remove_workspace,
        commands::reorder_workspace,
        commands::rename_workspace,
        commands::add_workspace_path,
        commands::remove_workspace_path,
        commands::set_workspace_paths,
        commands::reorder_workspace_path,
        commands::clone_repo,
        commands::git_status,
        commands::git_pr_status,
        commands::git_pr_details,
        commands::git_pr_diff,
        commands::git_edit_pr_title,
        commands::git_close_pr,
        commands::git_merge_pr,
        commands::git_changes,
        commands::git_file_at_head,
        commands::git_stage_file,
        commands::git_unstage_file,
        commands::git_discard_file,
        commands::git_diff,
        commands::git_apply_patch,
        commands::git_commit_staged,
        commands::git_push,
        commands::git_create_pr,
        commands::git_commit_log,
        commands::git_commit_diff,
        commands::git_diff_stat,
        commands::git_fetch,
        commands::git_pull,
        commands::git_force_pull,
        commands::git_rebase_on_main,
        commands::git_sync,
        commands::git_stash,
        commands::git_stash_pop,
        commands::git_stash_count,
        commands::git_list_branches,
        commands::git_checkout_branch,
        commands::git_create_branch,
        commands::git_delete_branch,
        commands::list_directory,
        commands::list_gitignored,
        commands::detect_git_info,
        commands::trash_file,
        commands::rename_file,
        commands::reveal_in_finder,
        commands::kill_port,
        commands::list_scripts,
        commands::read_rally_config,
        commands::update_rally_config_status_bar,
        commands::check_workspace_ready,
        commands::file_exists,
        commands::read_clipboard_text,
        commands::save_clipboard_image,
        pty_manager::spawn_pty,
        pty_manager::write_pty,
        pty_manager::write_pty_string,
        pty_manager::resize_pty,
        pty_manager::kill_pty,
        pty_manager::list_ptys,
        pty_manager::kill_all_ptys,
        pty_manager::get_pty_foreground_process,
        config_ops::get_home_dir,
        config_ops::read_file_content,
        config_ops::read_file_base64,
        config_ops::write_file_content,
        config_ops::create_directory,
        config_ops::path_status,
        config_ops::list_claude_configs,
        config_ops::list_skills,
        rally::search_ops::search_in_files,
        rally::search_ops::replace_in_files,
        rally::search_ops::list_all_files,
        rally::search_ops::list_directory_entries,
    ]);

    builder
        // Intercept window close button (red X):
        // - if more than one window exists: confirm closing only this window
        // - if this is the last window: confirm quitting Rally
        .on_window_event({
            let quit_showing = quit_showing.clone();
            let close_window_showing = close_window_showing.clone();
            let bypass_close_confirm = bypass_close_confirm.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // In test mode, allow close without confirmation
                    if is_test_mode() {
                        return;
                    }

                    let label = window.label().to_string();

                    // Standalone view windows (file/URL viewers) close without confirmation
                    if label.starts_with("rally-view-") {
                        return;
                    }

                    if let Ok(mut bypass) = bypass_close_confirm.lock() {
                        if bypass.remove(&label) {
                            return;
                        }
                    } else {
                        eprintln!("Failed to lock close-window bypass set");
                    }

                    api.prevent_close();
                    if window.app_handle().webview_windows().len() > 1 {
                        show_close_window_dialog(
                            window.clone(),
                            close_window_showing.clone(),
                            bypass_close_confirm.clone(),
                        );
                    } else {
                        show_quit_dialog(window.app_handle().clone(), quit_showing.clone());
                    }
                }
            }
        })
        // Intercept our custom "Quit Rally" menu item — shows confirmation dialog
        .on_menu_event({
            let quit_showing = quit_showing.clone();
            move |app, event| {
                match event.id().as_ref() {
                    "custom-quit" => {
                        show_quit_dialog(app.clone(), quit_showing.clone());
                    }
                    "file-new-file" => {
                        emit_to_focused_window(app, "rally-menu-new-file");
                    }
                    "file-new-workspace" => {
                        emit_to_focused_window(app, "rally-menu-new-workspace");
                    }
                    "file-add-folder" => {
                        emit_to_focused_window(app, "rally-menu-add-folder");
                    }
                    "file-new-claude" => {
                        emit_to_focused_window(app, "rally-menu-new-claude");
                    }
                    "file-new-window" => {
                        emit_to_focused_window(app, "rally-menu-new-window");
                    }
                    "file-open-current-workspace-new-window" => {
                        emit_to_focused_window(app, "rally-menu-open-current-workspace-new-window");
                    }
                    "view-flight-mode" => {
                        emit_to_focused_window(app, "rally-menu-flight-mode");
                    }
                    "view-dev-mode" => {
                        emit_to_focused_window(app, "rally-menu-dev-mode");
                    }
                    "view-zoom-in" => {
                        emit_to_focused_window(app, "rally-zoom-in");
                    }
                    "view-zoom-out" => {
                        emit_to_focused_window(app, "rally-zoom-out");
                    }
                    "view-zoom-reset" => {
                        emit_to_focused_window(app, "rally-zoom-reset");
                    }
                    _ => {}
                }
            }
        })
        .setup({
            #[cfg(feature = "test-bridge")]
            let test_pending = test_bridge_pending.clone();

            move |app| {
            // Start the CLI server (localhost HTTP listener for `rally` CLI)
            rally::cli_server::start(app.handle().clone());

            // --- Test mode setup ---
            #[cfg(feature = "test-bridge")]
            if is_test_mode() {
                eprintln!("[test-mode] Rally starting in test mode");
                rally::test_server::setup_listener(app.handle(), test_pending.clone());
                rally::test_server::start(app.handle().clone(), test_pending.clone());

                // Inject bridge script after React has mounted.
                // We spawn a thread that waits briefly, then evals the bridge JS.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Wait for React to mount (the Vite-built frontend loads fast)
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let bridge_js = include_str!("../resources/test-bridge.js");
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(e) = window.eval(bridge_js) {
                            eprintln!("[test-mode] bridge inject failed: {}", e);
                        } else {
                            eprintln!("[test-mode] bridge injected successfully");
                            // Mark the app as ready for tests
                            rally::test_server::mark_ready();
                        }
                    } else {
                        eprintln!("[test-mode] no main window found for bridge injection");
                    }
                });
            }

            // Custom app menu: replaces the default Quit with our own that shows
            // a confirmation dialog. macOS Cmd+Q normally triggers RunEvent::Exit
            // directly (impossible to prevent), so we replace the Quit menu item
            // with a custom one bound to Cmd+Q that routes through on_menu_event.
            let app_submenu = SubmenuBuilder::new(app, "Rally")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(
                    &MenuItemBuilder::with_id("custom-quit", "Quit Rally")
                        .accelerator("CmdOrCtrl+Q")
                        .build(app)?,
                )
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(
                    &MenuItemBuilder::with_id("file-new-file", "New File")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("file-new-workspace", "New Workspace...")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("file-add-folder", "Add Folder to Workspace...")
                        .accelerator("CmdOrCtrl+Shift+O")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("file-new-claude", "New Claude Code")
                        .accelerator("CmdOrCtrl+Shift+C")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("file-new-window", "New Window")
                        .accelerator("CmdOrCtrl+Shift+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id(
                        "file-open-current-workspace-new-window",
                        "Open Current Workspace in New Window",
                    )
                    .build(app)?,
                )
                .build()?;

            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(
                    &MenuItemBuilder::with_id("view-zoom-in", "Zoom In")
                        .accelerator("CmdOrCtrl+=")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("view-zoom-out", "Zoom Out")
                        .accelerator("CmdOrCtrl+-")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("view-zoom-reset", "Actual Size")
                        .accelerator("CmdOrCtrl+0")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("view-flight-mode", "Flight Mode")
                        .accelerator("CmdOrCtrl+Shift+F")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("view-dev-mode", "Dev Mode")
                        .accelerator("CmdOrCtrl+Shift+D")
                        .build(app)?,
                )
                .separator()
                .fullscreen()
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .build()?;

            let menu = tauri::menu::Menu::with_items(
                app,
                &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu, &window_submenu],
            )?;
            app.set_menu(menu)?;

            let win = app.get_webview_window("main").unwrap();

            // --- Native macOS frosted glass via raw Objective-C ---
            // Tauri's built-in vibrancy doesn't properly make WKWebView transparent.
            // We directly access the NSWindow and WKWebView to:
            // 1. Make the window non-opaque with clear background
            // 2. Disable WKWebView's opaque background drawing
            // 3. Add an NSVisualEffectView behind the webview for frosted blur
            {
                use objc2::runtime::AnyObject;
                use objc2::{msg_send, MainThreadMarker};
                use objc2_app_kit::{
                    NSColor, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
                    NSVisualEffectState, NSVisualEffectView, NSWindow,
                    NSAutoresizingMaskOptions, NSWindowOrderingMode,
                };
                use objc2_foundation::NSString;

                // We're in the setup callback which runs on the main thread
                let mtm = MainThreadMarker::new().unwrap();

                let ns_win_ptr = win.ns_window().unwrap() as *mut AnyObject;
                let ns_window: &NSWindow = unsafe { &*(ns_win_ptr as *const NSWindow) };

                unsafe {
                    // Make the window transparent
                    ns_window.setOpaque(false);
                    let clear = NSColor::clearColor();
                    ns_window.setBackgroundColor(Some(&clear));

                    // Get the content view and make the WKWebView non-opaque
                    if let Some(content_view) = ns_window.contentView() {
                        let subviews = content_view.subviews();
                        for i in 0..subviews.len() {
                            let subview = &*subviews.objectAtIndex(i);
                            // Set drawsBackground = false via KVC on WKWebView
                            let key = NSString::from_str("drawsBackground");
                            // Create NSNumber(false) via msg_send
                            let cls = objc2::runtime::AnyClass::get(c"NSNumber").unwrap();
                            let no_val: *mut AnyObject = msg_send![cls, numberWithBool: false];
                            let _: () = msg_send![subview, setValue: no_val, forKey: &*key];
                        }

                        // Add NSVisualEffectView behind everything for frosted glass
                        let effect_view = NSVisualEffectView::new(mtm);
                        effect_view.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
                        effect_view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                        effect_view.setState(NSVisualEffectState::Active);
                        effect_view.setAutoresizingMask(
                            NSAutoresizingMaskOptions::ViewWidthSizable
                                | NSAutoresizingMaskOptions::ViewHeightSizable,
                        );
                        effect_view.setFrame(content_view.frame());

                        // Insert the effect view at the back (behind webview)
                        let first_subview = if subviews.len() > 0 {
                            Some(&*subviews.objectAtIndex(0))
                        } else {
                            None
                        };
                        content_view.addSubview_positioned_relativeTo(
                            &effect_view,
                            NSWindowOrderingMode::Below,
                            first_subview,
                        );
                    }
                }
            }
            // Only position on largest monitor's left half on first launch.
            // On subsequent launches, tauri_plugin_window_state restores the
            // saved position/size before setup runs — we must not override it.
            let has_saved_state = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join(".window-state.json"))
                .map(|p| p.exists())
                .unwrap_or(false);

            if !has_saved_state {
                if let Ok(monitors) = win.available_monitors() {
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
            }
            Ok(())
        }})
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run({
            move |_app_handle, event| {
                match event {
                    // Prevent the app from exiting when the last window is "closed"
                    // (code is None). When app.exit(code) is called explicitly
                    // (code is Some), let the exit proceed.
                    tauri::RunEvent::ExitRequested { api, code, .. } => {
                        if code.is_none() {
                            api.prevent_exit();
                        }
                    }
                    // Kill all PTY processes on app exit to prevent orphaned shells
                    tauri::RunEvent::Exit => {
                        if let Ok(mut manager) = pty_exit.lock() {
                            manager.kill_all();
                        }
                    }
                    _ => {}
                }
            }
        });
}
