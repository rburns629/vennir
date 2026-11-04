// SPDX-License-Identifier: MIT
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/HomeOutlined";
import CatalogIcon from "@mui/icons-material/GridViewOutlined";
import ApiIcon from "@mui/icons-material/CodeOutlined";
import ComposeIcon from "@mui/icons-material/AccountTreeOutlined";
import RunsIcon from "@mui/icons-material/PlayArrowOutlined";
import ObserveIcon from "@mui/icons-material/InsightsOutlined";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import AdminIcon from "@mui/icons-material/VerifiedUserOutlined";
import SettingsIcon from "@mui/icons-material/SettingsOutlined";
import PersonIcon from "@mui/icons-material/PersonOutlined";
import DocsIcon from "@mui/icons-material/MenuBookOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import CollapseIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import ExpandIcon from "@mui/icons-material/KeyboardDoubleArrowRight";
import type { Me } from "../api";
import { useAuth } from "../auth/AuthContext";
import { PageErrorBoundary } from "../components/ErrorPage";
import { useEnvironment } from "../environment";
import { AskProvider, ChatLauncher } from "./ChatLauncher";
import { NotificationBell } from "./NotificationBell";
import { SIDEBAR_TIP } from "./sidebarTip";

/** The sidebar's width: dragged between these; under COMPACT_BELOW it keeps just the icons (Motion board). */
const WIDTH = { default: 248, min: 72, max: 360, compactBelow: 150 } as const;
const WIDTH_KEY = "vennir.sidebarWidth";

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
  /** Paths that belong to it too. */
  also?: string[];
  /** Paths under it that are another item's. */
  not?: string[];
}

/** Each place in the console. */
const NAV_ITEMS: NavItem[] = [
  { label: "Home", to: "/", icon: <HomeIcon /> },
  { label: "Catalog", to: "/catalog", icon: <CatalogIcon />, also: ["/products"], not: ["/catalog/compose"] },
  { label: "APIs", to: "/apis", icon: <ApiIcon /> },
  { label: "Compose", to: "/catalog/compose", icon: <ComposeIcon /> },
  { label: "Runs", to: "/runs", icon: <RunsIcon /> },
  { label: "Observe", to: "/observe", icon: <ObserveIcon /> },
  { label: "Teams", to: "/teams", icon: <GroupsIcon /> },
];
const ADMIN_ITEM: NavItem = { label: "Admin", to: "/admin", icon: <AdminIcon /> };

const isUnder = (path: string, prefix: string) => (prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`));
const isAt = (path: string, item: NavItem) =>
  [item.to, ...(item.also ?? [])].some((p) => isUnder(path, p)) && !(item.not ?? []).some((p) => isUnder(path, p));

/** Who you are here, in a few words: "admin", "maintainer · azure-apps". */
function roleLine(user: Me): string {
  if (user.isAdmin) return "admin";
  const [first] = user.maintainerOf;
  if (first) return `maintainer · ${first}`;
  const [team] = user.teamNames;
  return team ? `member · ${team}` : "no team yet";
}

const clamp = (width: number) => Math.min(WIDTH.max, Math.max(WIDTH.min, Math.round(width)));

/** The width last chosen in this browser: a convenience, so the default when storage isn't there. */
function storedWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved > 0 ? clamp(saved) : WIDTH.default;
  } catch {
    return WIDTH.default;
  }
}

/** The sidebar's width, kept in this browser, and what changes it. */
function useSidebarWidth() {
  const [width, setWidth] = useState(storedWidth);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Private window or blocked storage: the width lasts this page only.
    }
  }, [width]);
  const set = useCallback((next: number) => { setWidth(clamp(next)); }, []);
  return [width, set] as const;
}

/** Two DAG steps feeding a third: the Vennir mark. */
function Mark() {
  return (
    <Box component="svg" viewBox="0 0 24 24" sx={{ width: 22, height: 22, flexShrink: 0, color: "sidebar.accent" }} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M7 7.5l3.5 8.5M17 7.5l-3.5 8.5" />
      </g>
    </Box>
  );
}

/** Which install this tab is talking to (the chart's environmentLabel). */
function InstallCard() {
  const label = useEnvironment()?.label;
  if (!label) return null;
  return (
    <Box sx={{ mx: 1.5, px: 1.5, py: 1.25, borderRadius: 2, bgcolor: "sidebar.hoverBg", display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography sx={{ fontSize: 11, color: "sidebar.textMuted", textTransform: "uppercase", letterSpacing: 0.6 }}>This install</Typography>
      <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 13, color: "sidebar.text", overflowWrap: "anywhere" }}>{label}</Typography>
    </Box>
  );
}

const onDarkButton = {
  color: "sidebar.text",
  borderRadius: 2,
  "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
  "&.Mui-focusVisible": { outlineColor: (t: { palette: { sidebar: { accent: string } } }) => t.palette.sidebar.accent },
} as const;

/**
 * The sidebar's right edge: drag it to resize, or focus it and use the
 * arrow keys (Home and End for narrowest and widest). A window splitter, as
 * ARIA has it.
 */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onWidth(start.current.width + e.clientX - start.current.x);
  };
  const up = () => { start.current = null; };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: WIDTH.min, End: WIDTH.max }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onWidth(next);
  };
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={WIDTH.min}
      aria-valuemax={WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => { onWidth(WIDTH.default); }}
      sx={{
        position: "absolute",
        top: 0,
        right: -4,
        width: 8,
        height: "100%",
        cursor: "col-resize",
        zIndex: 1,
        touchAction: "none",
        "&:hover, &:focus-visible": { bgcolor: "sidebar.accent", opacity: 0.5 },
        "&:focus-visible": { outline: "none" },
        transition: "background-color 120ms",
      }}
    />
  );
}

function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Below md the sidebar would take most of a phone's width, so it becomes
  // a temporary drawer opened from a top bar instead of a permanent column.
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [navOpen, setNavOpen] = useState(false);
  const [width, setWidth] = useSidebarWidth();
  // The phone's drawer is always full; only the desktop's column narrows.
  const drawerWidth = isDesktop ? width : WIDTH.default;
  const compact = isDesktop && width < WIDTH.compactBelow;

  if (!user) return null;

  const items = user.isAdmin ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS;

  const goTo = (to: string) => {
    setMenuAnchor(null);
    setNavOpen(false);
    navigate(to);
  };

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <Drawer
        variant={isDesktop ? "permanent" : "temporary"}
        open={isDesktop || navOpen}
        onClose={() => { setNavOpen(false); }}
        ModalProps={{ keepMounted: true }}
        sx={{
          width: isDesktop ? drawerWidth : undefined,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: drawerWidth,
            boxSizing: "border-box",
            bgcolor: "sidebar.background",
            borderRight: 1,
            borderColor: "sidebar.border",
            color: "sidebar.text",
            overflowX: "hidden",
            overflowY: "visible",
            pt: 2.5,
            pb: 1.5,
            gap: 2.5,
          },
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: compact ? "center" : "space-between", px: compact ? 0 : 2.25, pr: compact ? 0 : 1, gap: 1 }}>
          <Box
            component={RouterLink}
            to="/"
            aria-label={compact ? "Vennir home" : undefined}
            onClick={() => { setNavOpen(false); }}
            sx={{ display: "flex", alignItems: "center", gap: 1.25, color: "sidebar.textStrong", textDecoration: "none", fontWeight: 600, fontSize: 17, minHeight: 32 }}
          >
            <Mark />
            {!compact && "Vennir"}
          </Box>
          {isDesktop && !compact && (
            <Tooltip title="Collapse the side menu to icons">
              <IconButton aria-label="Collapse the side menu to icons" onClick={() => { setWidth(WIDTH.min); }} sx={{ ...onDarkButton, color: "sidebar.textMuted" }}>
                <CollapseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {compact && (
          <Box sx={{ display: "flex", justifyContent: "center", mt: -1.25 }}>
            <Tooltip title="Expand the side menu" {...SIDEBAR_TIP}>
              <IconButton aria-label="Expand the side menu" onClick={() => { setWidth(WIDTH.default); }} sx={{ ...onDarkButton, color: "sidebar.textMuted" }}>
                <ExpandIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {!compact && <InstallCard />}

        <List component="nav" aria-label="Main" sx={{ px: 1.5, py: 0, flexGrow: 1 }}>
          {items.map((item) => {
            const selected = isAt(location.pathname, item);
            const button = (
              <ListItemButton
                key={item.to}
                component={RouterLink}
                to={item.to}
                selected={selected}
                aria-current={selected ? "page" : undefined}
                aria-label={compact ? item.label : undefined}
                onClick={() => { setNavOpen(false); }}
                sx={{
                  borderRadius: 2,
                  mb: 0.25,
                  minHeight: 44,
                  justifyContent: compact ? "center" : undefined,
                  px: compact ? 0 : undefined,
                  color: selected ? "sidebar.activeText" : "sidebar.text",
                  "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
                  "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
                  "&.Mui-selected": {
                    bgcolor: "sidebar.activeBg",
                    "&:hover": { bgcolor: "sidebar.activeBg" },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: compact ? 0 : 32, color: "inherit", "& svg": { fontSize: 19 } }}>{item.icon}</ListItemIcon>
                {!compact && <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 14, fontWeight: selected ? 500 : 400 } } }} />}
              </ListItemButton>
            );
            return compact ? (
              <Tooltip key={item.to} title={item.label} {...SIDEBAR_TIP}>
                {button}
              </Tooltip>
            ) : (
              button
            );
          })}
        </List>

        {isDesktop && <ChatLauncher placement="sidebar" compact={compact} />}

        <Box
          sx={{
            display: "flex",
            flexDirection: compact ? "column" : "row",
            alignItems: "center",
            gap: compact ? 1 : 1.25,
            mx: 1.5,
            pt: 1.25,
            px: compact ? 0 : 0.75,
            borderTop: 1,
            borderColor: "sidebar.border",
          }}
        >
          <Tooltip title={compact ? `${user.email} (${roleLine(user)})` : ""} {...SIDEBAR_TIP}>
            <Avatar
              sx={{ width: 32, height: 32, bgcolor: "primary.main", fontSize: 12, fontWeight: 600 }}
              aria-hidden={compact ? undefined : "true"}
              aria-label={compact ? user.email : undefined}
            >
              {user.email.slice(0, 2).toUpperCase()}
            </Avatar>
          </Tooltip>
          {!compact && (
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <Typography noWrap sx={{ fontSize: 13, color: "sidebar.textStrong", lineHeight: 1.35 }}>
                {user.email}
              </Typography>
              <Typography noWrap sx={{ fontSize: 12, color: "sidebar.textMuted", lineHeight: 1.35 }}>
                {roleLine(user)}
              </Typography>
            </Box>
          )}
          {isDesktop && <NotificationBell onDark />}
          <IconButton
            aria-label="Settings"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => { setMenuAnchor(event.currentTarget); }}
            sx={onDarkButton}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Box>
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={() => { setMenuAnchor(null); }}
          anchorOrigin={{ vertical: "top", horizontal: "right" }}
          transformOrigin={{ vertical: "bottom", horizontal: compact ? "left" : "right" }}
        >
          <MenuItem onClick={() => { goTo("/account"); }}>
            <ListItemIcon>
              <PersonIcon fontSize="small" />
            </ListItemIcon>
            Preferences
          </MenuItem>
          <MenuItem onClick={() => { goTo("/docs"); }}>
            <ListItemIcon>
              <DocsIcon fontSize="small" />
            </ListItemIcon>
            Help and guides
          </MenuItem>
          <MenuItem
            onClick={() => {
              logout();
              goTo("/login");
            }}
            sx={{ color: "error.main" }}
          >
            <ListItemIcon sx={{ color: "inherit" }}>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        </Menu>
        {isDesktop && <ResizeHandle width={width} onWidth={setWidth} />}
      </Drawer>

      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {!isDesktop && (
          <AppBar position="sticky" color="inherit" elevation={0}>
            <Toolbar sx={{ gap: 1 }}>
              <IconButton edge="start" aria-label="Open navigation" onClick={() => { setNavOpen(true); }}>
                <MenuIcon />
              </IconButton>
              <Typography sx={{ fontWeight: 600, fontSize: 16, flexGrow: 1 }}>Vennir</Typography>
              <ChatLauncher placement="toolbar" />
              <NotificationBell />
            </Toolbar>
          </AppBar>
        )}
        {/* No maxWidth/centering here on purpose -- that squeezed every page,
            including ones that genuinely want the full available width,
            into the same narrow centered column regardless of what
            they're actually showing. */}
        <Box component="main" sx={{ flexGrow: 1, px: { xs: 2, sm: 3, md: 6 }, pt: { xs: 2, sm: 3, md: 4 }, pb: 6, minWidth: 0 }}>
          <Suspense
            fallback={
              <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                <CircularProgress size={28} aria-label="Loading page" />
              </Box>
            }
          >
            {/* A new page starts afresh (its state and any error), except moving
                within help (its open contents, loaded guides) or Admin (its summary,
                read once); an error still clears on any move. */}
            <PageErrorBoundary key={KEEPS_STATE.find((p) => location.pathname === p || location.pathname.startsWith(`${p}/`)) ?? location.pathname} resetOn={location.pathname}>
              <Outlet />
            </PageErrorBoundary>
          </Suspense>
        </Box>
      </Box>
    </Box>
  );
}

/** The shell, with Ask Vennir for every page in it. */
/** Pages that keep their state moving between their own sub-pages. */
const KEEPS_STATE = ["/docs", "/admin"];

export function AppLayout() {
  return (
    <AskProvider>
      <Shell />
    </AskProvider>
  );
}
