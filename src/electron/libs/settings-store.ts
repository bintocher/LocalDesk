import { app } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { ApiSettings } from "../types.js";

const SETTINGS_FILE = "api-settings.json";

function getSettingsPath(): string {
  const userDataPath = app.getPath("userData");
  return join(userDataPath, SETTINGS_FILE);
}

export function loadApiSettings(): ApiSettings | null {
  try {
    const settingsPath = getSettingsPath();
    if (!existsSync(settingsPath)) {
      return null;
    }
    
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as ApiSettings;
    
    // Return null if all fields are empty
    if (!settings.apiKey && !settings.baseUrl && !settings.model) {
      return null;
    }
    
    // Set default permissionMode to 'ask' if not specified
    if (!settings.permissionMode) {
      settings.permissionMode = 'ask';
    }
    
    return settings;
  } catch (error) {
    console.error("Failed to load API settings:", error);
    return null;
  }
}

export function saveApiSettings(settings: ApiSettings): void {
  try {
    const settingsPath = getSettingsPath();
    const dir = dirname(settingsPath);
    
    // Ensure directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save API settings:", error);
    throw new Error("Failed to save settings");
  }
}
