"use client";
import { ModuleRegistry, AllCommunityModule, themeQuartz } from "ag-grid-community";
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise";

let done = false;
export function registerAgGrid() {
  if (done) return;
  done = true;
  ModuleRegistry.registerModules([AllCommunityModule, AllEnterpriseModule]);
  const key = process.env.NEXT_PUBLIC_AG_GRID_LICENSE;
  if (key) LicenseManager.setLicenseKey(key);
}

/** App grid theme (AG Grid Theming API). */
export const fcTheme = themeQuartz.withParams({
  fontFamily: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
  fontSize: 15,
  foregroundColor: "#161513",
  backgroundColor: "#fffdf6",
  headerBackgroundColor: "#fffdf6",
  headerTextColor: "#6a6459",
  headerFontWeight: 600,
  headerFontSize: 11, headerFontFamily: "'JetBrains Mono', monospace",
  borderColor: "#d9d0bd", columnBorder: false, headerColumnBorder: false, headerColumnResizeHandleColor: "transparent",
  rowBorder: { color: "#e6dfcf" }, headerRowBorder: { color: "#161513", width: 1.5 },
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHoverColor: "#f8f6e4",
  selectedRowBackgroundColor: "#f7f9cf",
  accentColor: "#161513",
  cellHorizontalPadding: 18,
  spacing: 7,
  oddRowBackgroundColor: "#fffdf6",
});

export const fcLogTheme = fcTheme.withParams({
  fontSize: 13,
  backgroundColor: "#161513",
  foregroundColor: "#ece6d6",
  headerBackgroundColor: "#0e0d0c",
  headerTextColor: "#a39c8c",
  borderColor: "#2c2a26",
  rowBorder: { color: "#24221f" },
  rowHoverColor: "#22201c",
  oddRowBackgroundColor: "#161513",
  cellHorizontalPadding: 12,
  spacing: 5,
});
