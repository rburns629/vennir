// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import NotificationsIcon from "@mui/icons-material/NotificationsNoneOutlined";
import { listNotifications, markNotificationsRead, type Notification } from "../api";
import { when } from "../time";

const REFRESH_MS = 60_000;

const TONE: Record<Notification["kind"], string> = {
  run_failed: "error.main",
  run_succeeded: "success.main",
  approval_waiting: "warning.main",
  catalog_failing: "error.main",
  product_not_ready: "warning.main",
  step_refused: "error.main",
  platform_alert: "warning.main",
  api_access: "info.main",
};

/**
 * Your notifications (NotificationService): a bell with how many are
 * unread, opening the newest. Opening one marks it read and goes to what
 * it's about. Looked at again every minute, and on opening. `onDark`: in
 * the dark sidebar.
 */
export function NotificationBell({ onDark = false }: { onDark?: boolean }) {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    listNotifications()
      .then(({ notifications, unreadCount }) => {
        setItems(notifications);
        setUnread(unreadCount);
      })
      .catch(() => undefined); // Display only: the page works without it.
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  function open(item: Notification): void {
    setAnchor(null);
    if (!item.read) {
      setItems((current) => current.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
      setUnread((n) => Math.max(0, n - 1));
      void markNotificationsRead([item.id]).catch(() => undefined);
    }
    if (item.link) navigate(item.link);
  }

  function readAll(): void {
    setItems((current) => current.map((n) => ({ ...n, read: true })));
    setUnread(0);
    void markNotificationsRead("all").catch(() => undefined);
  }

  return (
    <>
      <IconButton
        aria-label={unread > 0 ? `Notifications, ${String(unread)} unread` : "Notifications"}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          load();
        }}
        sx={
          onDark
            ? {
                color: "sidebar.text",
                borderRadius: 2,
                "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
                "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
              }
            : undefined
        }
      >
        <Badge badgeContent={unread} color="error" max={99}>
          <NotificationsIcon fontSize="small" />
        </Badge>
      </IconButton>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => { setAnchor(null); }}
        anchorOrigin={onDark ? { vertical: "top", horizontal: "right" } : { vertical: "bottom", horizontal: "right" }}
        transformOrigin={onDark ? { vertical: "bottom", horizontal: "left" } : { vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: "calc(100vw - 32px)", maxHeight: 480, display: "flex", flexDirection: "column" } } }}
      >
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="subtitle2" component="h2">
            Notifications
          </Typography>
          {unread > 0 && (
            <Button size="small" onClick={readAll}>
              Mark all read
            </Button>
          )}
        </Box>
        <Box sx={{ overflowY: "auto" }}>
          {items.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              Nothing yet. Your runs finishing, and steps waiting for your team&apos;s approval, show up here.
            </Typography>
          ) : (
            items.map((item) => (
              <ButtonBase
                key={item.id}
                onClick={() => { open(item); }}
                sx={{ display: "flex", alignItems: "flex-start", justifyContent: "flex-start", gap: 1.25, width: "100%", textAlign: "left", px: 2, py: 1.25, borderBottom: 1, borderColor: "divider", "&:hover": { bgcolor: "action.hover" } }}
              >
                <Box sx={{ flex: "0 0 8px", height: 8, mt: 0.75, borderRadius: "50%", bgcolor: item.read ? "transparent" : TONE[item.kind] }} aria-hidden="true" />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: item.read ? 400 : 600, overflowWrap: "anywhere" }}>
                    {item.title}
                  </Typography>
                  {item.body && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
                      {item.body}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {when(item.createdAt)}
                  </Typography>
                </Box>
              </ButtonBase>
            ))
          )}
        </Box>
      </Popover>
    </>
  );
}
