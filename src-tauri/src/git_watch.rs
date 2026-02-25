use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const GIT_CHANGES_UPDATED_EVENT: &str = "git-changes-updated";
const DEBOUNCE_MS: u64 = 700;
const IGNORED_DIRS: &[&str] = &["node_modules", "dist", "target", ".angular", ".nx"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangesUpdatedPayload {
    root_path: String,
}

#[derive(Clone)]
struct RepoDebouncer {
    dirty: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

impl RepoDebouncer {
    fn new() -> Self {
        Self {
            dirty: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn notify(&self, app: AppHandle, root_path: String) {
        self.dirty.store(true, Ordering::SeqCst);
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let dirty = self.dirty.clone();
        let running = self.running.clone();
        std::thread::spawn(move || loop {
            dirty.store(false, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
            if dirty.load(Ordering::SeqCst) {
                continue;
            }
            let _ = app.emit(
                GIT_CHANGES_UPDATED_EVENT,
                GitChangesUpdatedPayload {
                    root_path: root_path.clone(),
                },
            );
            running.store(false, Ordering::SeqCst);
            // Handle race: event may arrive between `load` and `running=false`.
            if dirty.swap(false, Ordering::SeqCst)
                && running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                continue;
            }
            break;
        });
    }
}

struct RepoWatcher {
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct GitWatchState {
    watchers: Mutex<HashMap<String, RepoWatcher>>,
}

fn is_ignored_path(path: &Path) -> bool {
    path.components().any(|component| {
        let c = component.as_os_str().to_string_lossy();
        IGNORED_DIRS.iter().any(|ignored| c == *ignored)
    })
}

fn should_emit_for_event(event: &Event, root_path: &str) -> bool {
    if event.paths.is_empty() {
        return true;
    }
    let root = Path::new(root_path);
    event.paths.iter().any(|p| {
        let candidate: PathBuf = if p.is_absolute() {
            p.clone()
        } else {
            root.join(p)
        };
        !is_ignored_path(&candidate)
    })
}

impl GitWatchState {
    fn add_repo_watcher(
        app: AppHandle,
        watchers: &mut HashMap<String, RepoWatcher>,
        root_path: &str,
    ) -> Result<(), String> {
        if watchers.contains_key(root_path) {
            return Ok(());
        }
        let root_path_string = root_path.to_string();
        let debouncer = RepoDebouncer::new();
        let app_clone = app.clone();
        let root_for_callback = root_path_string.clone();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let event = match res {
                Ok(ev) => ev,
                Err(err) => {
                    eprintln!("git watcher error ({}): {}", root_for_callback, err);
                    return;
                }
            };
            if !should_emit_for_event(&event, &root_for_callback) {
                return;
            }
            debouncer.notify(app_clone.clone(), root_for_callback.clone());
        })
        .map_err(|e| format!("failed to create watcher for {}: {}", root_path, e))?;

        watcher
            .watch(Path::new(root_path), RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {}", root_path, e))?;

        watchers.insert(
            root_path_string,
            RepoWatcher {
                _watcher: watcher,
            },
        );
        Ok(())
    }

    pub fn update_roots(&self, app: AppHandle, roots: Vec<String>) -> Result<(), String> {
        let desired: HashSet<String> = roots.into_iter().collect();
        let mut map = self
            .watchers
            .lock()
            .map_err(|_| "git watcher lock poisoned".to_string())?;

        map.retain(|root, _| desired.contains(root));

        for root in desired {
            let path = Path::new(&root);
            if !path.is_dir() {
                continue;
            }
            Self::add_repo_watcher(app.clone(), &mut map, &root)?;
        }

        Ok(())
    }
}
