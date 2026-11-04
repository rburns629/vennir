// SPDX-License-Identifier: MIT
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import { getChatSettings } from "../api";
import { useAuth } from "../auth/AuthContext";
import { AskContext, useAsk } from "./ask";
import { SIDEBAR_TIP } from "./sidebarTip";

// Fetched the first time it's opened: markdown rendering isn't every page's.
const ChatPanel = lazy(() => import("../components/ChatPanel").then((m) => ({ default: m.ChatPanel })));

/** The panel's width on a wider screen (board 13c); a phone's is the whole width. */
const PANEL_WIDTH = { xs: "100vw", sm: 480 };

/**
 * Ask Vennir (decision 24) for the whole app: whether there's a model, and
 * the chat panel, which any page can open (the sidebar's button, the
 * help's) and which keeps its conversation while closed.
 */
export function AskProvider({ children }: { children: ReactNode }) {
  // undefined while asking; null when there's no model.
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  // A question a page opened it with: a new object each time, so the same words twice still fill the box.
  const [question, setQuestion] = useState<{ text: string; send: boolean } | null>(null);
  // The question box, focused whenever the panel has opened.
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    getChatSettings()
      .then((s) => { setModel(s.enabled ? s.model : null); })
      .catch(() => { setModel(null); });
  }, []);

  const ask = useMemo(
    () => ({
      model,
      open: (text?: string, options?: { send?: boolean }) => {
        if (typeof model !== "string") return false;
        if (text) setQuestion({ text, send: options?.send ?? false });
        setOpen(true);
        setOpened(true);
        return true;
      },
    }),
    [model],
  );

  return (
    <AskContext.Provider value={ask}>
      {children}
      {typeof model === "string" && (
        <Drawer
          anchor="right"
          open={open}
          onClose={() => { setOpen(false); }}
          keepMounted={opened}
          slotProps={{ paper: { role: "dialog", "aria-label": "Ask Vennir", "aria-modal": true }, transition: { onEntered: () => { input.current?.focus(); } } }}
        >
          {opened && (
            <Suspense
              fallback={
                <Box sx={{ width: PANEL_WIDTH, display: "flex", justifyContent: "center", py: 6 }}>
                  <CircularProgress size={24} aria-label="Loading" />
                </Box>
              }
            >
              <ChatPanel model={model} width={PANEL_WIDTH} question={question} inputRef={input} onClose={() => { setOpen(false); }} />
            </Suspense>
          )}
        </Drawer>
      )}
    </AskContext.Provider>
  );
}

/**
 * Ask's button: in the sidebar beside the navigation on a desktop, in the
 * top bar on a phone. Without a model it's there but off, saying who turns
 * it on. `compact`: the collapsed sidebar's, its icon alone and its name on
 * hover.
 */
export function ChatLauncher({ placement, compact = false }: { placement: "sidebar" | "toolbar"; compact?: boolean }) {
  const { user } = useAuth();
  const { model, open } = useAsk();

  if (model === undefined) return null;
  const off = model === null;
  const why = user?.isAdmin ? "Not set up: choose its model in Admin, Chat agent" : "Not set up yet: an admin chooses its model";

  const trigger =
    placement === "sidebar" ? (
      <ListItemButton
        disabled={off}
        onClick={() => { open(); }}
        aria-label="Ask Vennir"
        sx={{
          // Its own height: the sidebar is a column, and ListItemButton grows to fill one.
          flex: "none",
          mx: 1.5,
          borderRadius: 2,
          minHeight: 44,
          justifyContent: compact ? "center" : undefined,
          px: compact ? 0 : undefined,
          border: 1,
          borderColor: "sidebar.border",
          color: "sidebar.text",
          "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
          "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
          "&.Mui-disabled": { opacity: 0.55 },
        }}
      >
        <ListItemIcon sx={{ minWidth: compact ? 0 : 32, color: off ? "inherit" : "sidebar.accent", "& svg": { fontSize: 19 } }}>
          <ChatIcon />
        </ListItemIcon>
        {!compact && (
          <ListItemText
            primary="Ask Vennir"
            secondary={off ? "Not set up" : undefined}
            slotProps={{ primary: { sx: { fontSize: 14 } }, secondary: { sx: { fontSize: 12, color: "sidebar.textMuted" } } }}
          />
        )}
      </ListItemButton>
    ) : (
      <IconButton aria-label="Ask Vennir" disabled={off} onClick={() => { open(); }}>
        <ChatIcon fontSize="small" />
      </IconButton>
    );

  // A disabled control gets no hover: the tooltip sits on what holds it.
  if (!off && !compact) return trigger;
  return (
    <Tooltip title={off ? why : "Ask Vennir"} {...(placement === "sidebar" ? SIDEBAR_TIP : { placement: "bottom" })}>
      <Box component="span" sx={{ display: placement === "sidebar" ? "block" : "inline-flex" }}>
        {trigger}
      </Box>
    </Tooltip>
  );
}
