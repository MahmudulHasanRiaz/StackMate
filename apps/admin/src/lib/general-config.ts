/**
 * Public general config (Auth + Email batch, General Settings).
 *
 * The SPA reads GET /api/v1/general-config once at boot (public — no
 * auth, no secrets) and applies it:
 *  - document.title = app_title
 *  - <link rel="icon"> = favicon_url (removed when no favicon)
 *  - <meta name="description"> = app_description
 *  - sidebar/topbar brand = app_name
 *  - login page = app_description + support_email
 *
 * The query is cached (staleTime 5 min); a Settings → General save
 * invalidates it, so the new values apply immediately with no reload.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

export interface GeneralConfig {
  app_name: string;
  app_title: string;
  app_description: string;
  support_email: string;
  favicon_url: string | null;
}

export const GENERAL_CONFIG_QUERY_KEY = ["public", "general-config"] as const;

export const DEFAULT_GENERAL_CONFIG: GeneralConfig = {
  app_name: "StackMate",
  app_title: "StackMate Admin",
  app_description: "",
  support_email: "",
  favicon_url: null,
};

async function fetchGeneralConfig(): Promise<GeneralConfig> {
  const res = await fetch("/api/v1/general-config", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return DEFAULT_GENERAL_CONFIG;
  const body = (await res.json().catch(() => ({}))) as {
    data?: GeneralConfig;
  };
  const data = body.data ?? (body as unknown as GeneralConfig);
  return {
    app_name: typeof data.app_name === "string" ? data.app_name : DEFAULT_GENERAL_CONFIG.app_name,
    app_title:
      typeof data.app_title === "string" ? data.app_title : DEFAULT_GENERAL_CONFIG.app_title,
    app_description:
      typeof data.app_description === "string"
        ? data.app_description
        : DEFAULT_GENERAL_CONFIG.app_description,
    support_email:
      typeof data.support_email === "string"
        ? data.support_email
        : DEFAULT_GENERAL_CONFIG.support_email,
    favicon_url:
      typeof data.favicon_url === "string" ? data.favicon_url : null,
  };
}

export function useGeneralConfig() {
  return useQuery({
    queryKey: GENERAL_CONFIG_QUERY_KEY,
    queryFn: fetchGeneralConfig,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** Apply the config to the document (title, favicon, meta description). */
export function applyGeneralConfig(config: GeneralConfig): void {
  document.title = config.app_title;
  const head = document.head;
  let icon = head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (config.favicon_url) {
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      head.appendChild(icon);
    }
    if (icon.href !== new URL(config.favicon_url, window.location.origin).href) {
      icon.href = config.favicon_url;
    }
  } else if (icon) {
    icon.remove();
  }
  if (config.app_description) {
    let meta = head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      head.appendChild(meta);
    }
    meta.content = config.app_description;
  }
}

/** Mount once at the app root: applies the public config when it loads. */
export function GeneralConfigApplier() {
  const { data } = useGeneralConfig();
  useEffect(() => {
    if (data) applyGeneralConfig(data);
  }, [data]);
  return null;
}
