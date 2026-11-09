// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ApiProduct } from "../../api";
import { Mono } from "../../components/Mono";

const AUTH: Record<string, string> = {
  service_account_token: "a token for the API's own ServiceAccount, minted per request",
  google_id_token: "a Google ID token, minted per request",
  aws_sig_v4: "AWS SigV4, as a role it assumes per request",
  entra_token: "a Microsoft Entra token, as an identity it signs in as per request",
  "": "nothing: it checks Vennir-Caller, or nothing",
};

/** What the gateway does with each request, in the order gateway/internal/gateway/gateway.go does it. */
const STEPS: [string, string][] = [
  ["Who is calling", "A person's session or a bot's token; Google sign-in when the caller's team requires it; else 401. A single sign-on over an hour old whose only way in is a group's grant signs in again (401). Until then, nothing about the API is said."],
  ["Can they see it?", "A hidden API is its own team's, admins' and whoever a grant lets in; else 404, as for no API at all."],
  ["Open?", "The gateway isn't closed, and the API isn't paused (with its message), held or unusable; else 503."],
  ["May they call it?", "In this order: its own team's members and bots; a grant naming them; a grant to a single sign-on group they're in (people only). Admins too need a grant. Else 403 NOT_GRANTED."],
  ["Small enough?", "The body is within its size limit; else 413."],
  ["In the spec?", "The method and path are an operation in its OpenAPI file; else 404, blocked."],
  ["Does it fit?", "Only the query parameters and body it declares, against that operation's schemas; else 400."],
  ["Within its rate", "Requests a minute: their grant's (a group's counted per member), or for its own team, its limit; else 429."],
  ["Forward", "Same method, path, query and body; Authorization swapped for the backend's, Vennir-Caller added; the caller's Forwarded and X-Forwarded-* dropped."],
  ["Answer", "The backend's response; any cookie it sets is kept to this API's path."],
];
/** The step the page highlights: what the "Blocked: not in the spec" table counts. */
const SPEC_STEP = 5;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, fontSize: 13, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </>
  );
}

/** What the catalog says an API is (its api.yaml): backend, how the gateway signs in there, where it's reachable. For its own team. */
export function ApiBackend({ api }: { api: ApiProduct }) {
  return (
    <Card component="section" aria-label="As the catalog says" sx={{ flex: "3 1 560px", minWidth: 0, p: 2.75, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="h6" component="h2">
          Its backend, as the catalog says
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          It changes in the catalog, reviewed like any product: propose a change to its file there. Pausing it is the only thing changed
          here.
        </Typography>
      </Box>
      <Box
        component="dl"
        sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(150px, auto) minmax(0, 1fr)" }, columnGap: 2.5, rowGap: { xs: 0.25, sm: 1.25 } }}
      >
        <Row label="Its file">
          <Mono sx={{ fontSize: 12.5 }}>{api.sourcePath}</Mono>
        </Row>
        <Row label="Backend">
          <Mono sx={{ fontSize: 12.5 }}>{api.backendUrl}</Mono>
        </Row>
        <Row label="The gateway signs in there with">{AUTH[api.backendAuth] ?? api.backendAuth}</Row>
        <Row label="Reachable">{api.internet ? "From the internet, and in the cluster" : "In the cluster only"}</Row>
      </Box>
    </Card>
  );
}

/** Pausing it for an incident, or resuming it: its team's maintainers and admins. */
export function ApiPause({
  api,
  busy,
  onPause,
  onResume,
}: {
  api: ApiProduct;
  busy: boolean;
  /** Resolves to whether it paused. */
  onPause: (message: string) => Promise<boolean>;
  onResume: () => Promise<unknown>;
}) {
  const [message, setMessage] = useState("");
  const paused = api.state === "PAUSED";
  return (
    <Card component="section" aria-label={paused ? "Resume it" : "Pause it"} sx={{ flex: "2 1 340px", minWidth: 0, p: 2.75, display: "flex", flexDirection: "column", gap: 1.5, borderColor: "warning.light" }}>
      <Typography variant="h6" component="h2">
        {paused ? "Resume it" : "Pause it"}
      </Typography>
      <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.5 }}>
        {paused
          ? `Paused: every signed-in caller gets 503 with “${api.pausedMessage}” (anyone else, 404), and nothing reaches the backend, until you resume it. Recorded in the audit log.`
          : `For an incident: every signed-in caller gets 503 with your message until you resume it (anyone else, 404), and nothing reaches the backend. Recorded in the audit log. ${api.team}’s maintainers and admins can.`}
      </Typography>
      {!paused && (
        <TextField
          size="small"
          fullWidth
          label="Message to callers"
          placeholder="Database failover; back by 15:00 UTC"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
          }}
          slotProps={{ htmlInput: { maxLength: 500 } }}
          sx={{ "& .MuiInputBase-root": { minHeight: 44 } }}
        />
      )}
      <Box>
        <Button
          variant="contained"
          size="large"
          color={paused ? "primary" : "warning"}
          disabled={busy || (!paused && !message.trim())}
          onClick={() =>
            void (paused
              ? onResume()
              : onPause(message).then((done) => {
                  // Kept to try again when pausing didn't work.
                  if (done) setMessage("");
                }))
          }
        >
          {paused ? "Resume" : "Pause this API"}
        </Button>
      </Box>
      {!paused && !message.trim() && (
        <Typography variant="caption" color="text.secondary">
          Write a message first; signed-in callers see it in every 503.
        </Typography>
      )}
    </Card>
  );
}

/** What the gateway does with each request, in order; the step that blocks what isn't in the spec stands out. */
export function RequestSteps() {
  return (
    <Card component="section" aria-label="What happens to a request" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Typography variant="h6" component="h2">
        What happens to a request
      </Typography>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 1.25, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {STEPS.map(([title, text], i) => (
          <Box
            component="li"
            key={title}
            sx={{
              p: 1.5,
              borderRadius: 2,
              border: 1,
              borderColor: i === SPEC_STEP ? "warning.light" : "divider",
              bgcolor: i === SPEC_STEP ? "warning.light" : "background.default",
              display: "flex",
              flexDirection: "column",
              gap: 0.5,
            }}
          >
            <Typography variant="caption" sx={{ fontFamily: "fontFamilyMono", fontSize: 11, color: "text.secondary" }}>
              {i + 1}
            </Typography>
            <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
              {title}
            </Typography>
            <Typography variant="caption" sx={{ lineHeight: 1.45 }}>
              {text}
            </Typography>
          </Box>
        ))}
      </Box>
    </Card>
  );
}
