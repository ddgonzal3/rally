import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../tauri";

/** Themes store an image's file name; the folder is resolved once per window. */
let dirPromise: Promise<string> | null = null;

function imagesDir(): Promise<string> {
  dirPromise ??= api.themeImagesDirPath();
  return dirPromise;
}

/** Loadable URL for a theme image file name, or null while resolving / when unset. */
export function useThemeImageUrl(name: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!name) {
      setUrl(null);
      return;
    }
    let live = true;
    imagesDir().then(
      (dir) => live && setUrl(convertFileSrc(`${dir}/${name}`)),
      (e) => console.error("[rally] theme images folder unavailable:", e),
    );
    return () => {
      live = false;
    };
  }, [name]);
  return url;
}
