// SPDX-License-Identifier: MIT
import { alpha, createTheme } from "@mui/material/styles";

// Vennir's design tokens. Everything the console colors or sets in mono
// comes from here; a page reaches these through sx by name
// (bgcolor: "code.background", fontFamily: "fontFamilyMono").

/** Two dark surfaces with different jobs: the sidebar is navigation
 * chrome, `code` is where machine output is read (logs, code samples). */
interface DarkSurface {
  background: string;
  text: string;
  textMuted: string;
  /** Highlights on this surface; the light-theme primary is too dark here. */
  accent: string;
}
/** The boards' quieter tints: edges and fills for what's about the install
 * (info) or waits on you (warning), and the hairline inside a card. */
interface TintPalette {
  infoBorder: string;
  infoSurface: string;
  warningBorder: string;
  warningSurface: string;
  errorBorder: string;
  successBorder: string;
  rule: string;
  neutral: string;
  /** A control's edge: fields, choice cards, outlined buttons. */
  field: string;
}
interface SidebarPalette extends DarkSurface {
  border: string;
  textStrong: string;
  activeBg: string;
  activeText: string;
  hoverBg: string;
}
declare module "@mui/material/styles" {
  interface Palette {
    sidebar: SidebarPalette;
    code: DarkSurface;
    tint: TintPalette;
  }
  interface PaletteOptions {
    sidebar?: SidebarPalette;
    code?: DarkSurface;
    tint?: TintPalette;
  }
  interface TypographyVariants {
    fontFamilyMono: string;
  }
  interface TypographyVariantsOptions {
    fontFamilyMono?: string;
  }
}

// The console's blue (the mockups' accent): 5.9:1 on white, 5.5:1 on the
// page background, so it carries text and white text on it.
const PRIMARY = "#2F5BD3";
const PRIMARY_DARK = "#1E3F9A";
// The same hue lightened for the dark surfaces (8.2:1 on the sidebar).
const PRIMARY_ON_DARK = "#8FB0FF";
const INK = "#16191F";
const INK_MUTED = "#5A6170";
const BORDER = "#E2E5EA";

// One keyboard focus ring for everything focusable, instead of MUI's
// per-component defaults (a faint background shift on list items and
// buttons, nothing at all on links and scroll regions). The 2px offset keeps
// it clear of the control's own border.
const FOCUS_RING = { outline: `2px solid ${PRIMARY}`, outlineOffset: 2 };

const SANS = ["'IBM Plex Sans'", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"].join(",");
const MONO = ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"].join(",");

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: PRIMARY, dark: PRIMARY_DARK },
    // A state's color is its text (and a filled chip's, under white text,
    // each 5:1 or more); light is the tint behind it.
    success: { main: "#1F7A4D", dark: "#17633F", light: "#E3F3EA" },
    warning: { main: "#8A4B00", dark: "#6F3C00", light: "#FCEFD9" },
    error: { main: "#B42318", dark: "#9F1F15", light: "#FDE8E6" },
    info: { main: PRIMARY_DARK, dark: "#172F73", light: "#EAF0FF" },
    text: { primary: INK, secondary: INK_MUTED },
    divider: BORDER,
    background: { default: "#F6F7F9", paper: "#FFFFFF" },
    sidebar: {
      background: INK,
      border: "#232833",
      text: "#C9CED8",
      textMuted: "#A9B0BD",
      textStrong: "#FFFFFF",
      accent: PRIMARY_ON_DARK,
      activeBg: "#2F3A52",
      activeText: "#FFFFFF",
      hoverBg: "#232833",
    },
    tint: {
      infoBorder: "#C9D6F7",
      infoSurface: "#F6F8FF",
      warningBorder: "#F0D9B5",
      warningSurface: "#FFFAF2",
      errorBorder: "#F2C4BE",
      successBorder: "#A8D5BC",
      rule: "#ECEEF2",
      neutral: "#ECEEF2",
      field: "#D5D9E0",
    },
    // One surface for every block of machine output. The success.light and
    // error.light event colors in the log feed pass on it.
    code: {
      background: INK,
      text: "#E8EAEE",
      textMuted: "#A9B0BD",
      accent: PRIMARY_ON_DARK,
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: SANS,
    fontFamilyMono: MONO,
    fontWeightMedium: 500,
    h4: { fontSize: 28, fontWeight: 600, lineHeight: 1.25 },
    h5: { fontSize: 20, fontWeight: 600 },
    h6: { fontSize: 16, fontWeight: 600 },
    button: { textTransform: "none", fontWeight: 500 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        "::selection": { backgroundColor: alpha(PRIMARY, 0.18) },
        // Figures in the mockups' mono: digests, ids, code.
        "code, kbd, samp, pre": { fontFamily: MONO },
        // Native focusables MUI doesn't style: links in rendered docs, the
        // focusable scroll regions (logs, code blocks, wide tables).
        "a:focus-visible, [tabindex='0']:focus-visible": { ...FOCUS_RING, borderRadius: 2 },
        // Counts, durations and timestamps line up column to column.
        "td, th": { fontVariantNumeric: "tabular-nums" },
        // Respect the OS setting: no slides, fades or ripples. The loading
        // spinner keeps turning, since a frozen one reads as a hang.
        "@media (prefers-reduced-motion: reduce)": {
          "*:not(.MuiCircularProgress-root):not(.MuiCircularProgress-svg):not(.MuiCircularProgress-circle), *::before, *::after": {
            animationDuration: "0.01ms !important",
            animationIterationCount: "1 !important",
            transitionDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
          },
        },
      },
    },
    MuiButtonBase: {
      styleOverrides: { root: { "&.Mui-focusVisible": FOCUS_RING } },
    },
    MuiAppBar: {
      defaultProps: { color: "inherit", elevation: 0 },
      styleOverrides: { root: { borderBottom: "1px solid rgba(0,0,0,0.08)" } },
    },
    // Flat surfaces: a 1px border, no shadow (the mockups' cards). Menus and
    // dialogs, which float, keep theirs.
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: "none" }, outlined: { borderColor: BORDER } },
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { borderRadius: 10 } },
    },
    MuiMenu: { defaultProps: { slotProps: { paper: { elevation: 4 } } } },
    MuiPopover: { defaultProps: { slotProps: { paper: { elevation: 4 } } } },
    MuiDialog: { defaultProps: { slotProps: { paper: { elevation: 8 } } } },
    MuiAutocomplete: { defaultProps: { slotProps: { paper: { elevation: 4 } } } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 8 }, sizeMedium: { minHeight: 40 }, sizeLarge: { minHeight: 44 } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 500 } },
    },
    MuiTableCell: {
      styleOverrides: { root: { borderColor: "#ECEEF2" }, head: { color: INK_MUTED, fontWeight: 500, fontSize: 13, backgroundColor: "#F9FAFB" } },
    },
    // Tabs as the mockups draw them: sentence case, 44px targets, the accent underline.
    MuiTabs: {
      styleOverrides: { root: { minHeight: 44, borderBottom: `1px solid ${BORDER}` }, indicator: { height: 2, borderRadius: 1 } },
    },
    MuiTab: {
      styleOverrides: {
        root: ({ theme }) => ({
          minHeight: 44,
          textTransform: "none",
          fontWeight: 500,
          fontSize: 14,
          color: theme.palette.text.secondary,
          "&.Mui-selected": { color: theme.palette.text.primary },
        }),
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true },
      styleOverrides: { tooltip: { backgroundColor: INK, fontSize: 12, fontWeight: 400, lineHeight: 1.45, padding: "6px 10px" }, arrow: { color: INK } },
    },
    // Messages sit flat on the page like the cards: a hairline in their own tone.
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          alignItems: "flex-start",
          variants: (
            [
              ["success", "#BFE3CD"],
              ["info", "#CBD8FB"],
              ["warning", "#F3D6A6"],
              ["error", "#F6C4BE"],
            ] as const
          ).map(([severity, border]) => ({ props: { variant: "standard", severity }, style: { border: `1px solid ${border}` } })),
        },
      },
    },
    // Unselected toggle buttons default to action.active (54% black), which
    // lands at 4.49:1 on the page background: just under AA.
    MuiToggleButton: {
      styleOverrides: { root: ({ theme }) => ({ color: theme.palette.text.secondary }) },
    },
  },
});
