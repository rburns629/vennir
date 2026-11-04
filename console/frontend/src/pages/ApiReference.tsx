// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Mono } from "../components/Mono";

/** The Docs page's id for this page; no guide may use it. */
export const API_REFERENCE_ID = "api-reference";

/** gen/api-reference.json, written by `make proto` from proto/ (console/scripts/api-reference.ts). */
interface Field {
  name: string;
  type: string;
  ref?: string;
  repeated: boolean;
  optional: boolean;
  comment: string;
}
interface Method {
  name: string;
  comment: string;
  input: string;
  output: string;
  streaming: boolean;
  idempotency: "read" | "idempotent" | "";
  public: boolean;
}
interface Service {
  name: string;
  fullName: string;
  comment: string;
  methods: Method[];
}
interface Reference {
  services: Service[];
  messages: Record<string, { name: string; comment: string; fields: Field[] }>;
  enums: Record<string, { name: string; comment: string; values: { name: string; comment: string }[] }>;
}

const anchor = (fullName: string) => `type-${fullName.replaceAll(".", "-")}`;

function jumpTo(fullName: string) {
  document.getElementById(anchor(fullName))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Paragraphs of a proto comment (lines wrapped at ~80 columns, blank lines between paragraphs). */
function Comment({ text }: { text: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/\n\s*\n/).map((paragraph) => (
        <Typography key={paragraph} variant="body2" sx={{ mb: 1 }}>
          {paragraph.replaceAll("\n", " ")}
        </Typography>
      ))}
    </>
  );
}

function TypeCell({ field, reference }: { field: Field; reference: Reference }) {
  const known = field.ref && (reference.messages[field.ref] ?? reference.enums[field.ref]);
  const name = field.repeated ? `list of ${field.type}` : field.type;
  return known && field.ref ? (
    <Link component="button" type="button" onClick={() => jumpTo(field.ref ?? "")} sx={{ fontFamily: "fontFamilyMono", fontSize: 14 }}>
      {name}
    </Link>
  ) : (
    <Mono>{name}</Mono>
  );
}

function Fields({ fullName, reference }: { fullName: string; reference: Reference }) {
  const message = reference.messages[fullName];
  if (!message || message.fields.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No fields: <Mono>{"{}"}</Mono>
      </Typography>
    );
  }
  return (
    <Box
      component="table"
      sx={{
        width: "100%",
        borderCollapse: "collapse",
        "& th, & td": { border: 1, borderColor: "divider", p: 1, textAlign: "left", verticalAlign: "top", fontSize: 14 },
        "& th": { bgcolor: "action.hover", fontWeight: 600 },
      }}
    >
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {message.fields.map((field) => (
          <tr key={field.name}>
            <td>
              <Mono>{field.name}</Mono>
              {field.optional && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  optional
                </Typography>
              )}
            </td>
            <td>
              <TypeCell field={field} reference={reference} />
            </td>
            <td>{field.comment.replaceAll("\n", " ")}</td>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}

/** A request body to start from: each field with a placeholder of its type. */
function sampleBody(fullName: string, reference: Reference): string {
  const fields = reference.messages[fullName]?.fields ?? [];
  const placeholder = (field: Field): unknown => {
    const value = field.ref
      ? reference.enums[field.ref]
        ? (reference.enums[field.ref]?.values[1]?.name ?? "")
        : {}
      : field.type.startsWith("integer")
        ? 0
        : field.type === "boolean"
          ? false
          : field.type.startsWith("map") || field.type === "object"
            ? {}
            : "…";
    return field.repeated ? [value] : value;
  };
  return JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, placeholder(f)])));
}

function MethodView({ service, method, reference }: { service: Service; method: Method; reference: Reference }) {
  const path = `/api/${service.fullName}/${method.name}`;
  const kind =
    method.idempotency === "read"
      ? { label: "read", color: "success" as const }
      : method.idempotency === "idempotent"
        ? { label: "idempotent", color: "warning" as const }
        : { label: "changes", color: "primary" as const };
  const curl = [
    `curl -X POST "$CONSOLE${path}" \\`,
    `  -H "Content-Type: application/json" \\`,
    ...(method.public ? [] : [`  -H "Authorization: Bearer $TOKEN" \\`]),
    `  -d '${sampleBody(method.input, reference)}'`,
  ].join("\n");
  return (
    <Accordion disableGutters variant="outlined" sx={{ "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", minWidth: 0 }}>
          <Chip label={kind.label} size="small" color={kind.color} sx={{ fontWeight: 700, minWidth: 88 }} />
          <Mono sx={{ fontWeight: 600 }}>{method.name}</Mono>
          {method.streaming && <Chip label="stream" size="small" variant="outlined" />}
          {method.public && <Chip label="no sign-in" size="small" variant="outlined" />}
          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
            {method.comment.split("\n")[0]}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Box>
            <Comment text={method.comment} />
            <Mono sx={{ overflowWrap: "anywhere" }}>POST {path}</Mono>
          </Box>
          {method.streaming ? (
            <Typography variant="body2" color="text.secondary">
              A server stream: call it with a Connect or gRPC client generated from the protos (a stream of JSON
              messages isn't something curl reads well).
            </Typography>
          ) : (
            <Box
              component="pre"
              sx={{ m: 0, p: 1.5, bgcolor: "action.hover", borderRadius: 1, overflowX: "auto", fontFamily: "fontFamilyMono", fontSize: 13 }}
            >
              {curl}
            </Box>
          )}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Request · <Mono>{reference.messages[method.input]?.name ?? method.input}</Mono>
            </Typography>
            <Fields fullName={method.input} reference={reference} />
          </Box>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {method.streaming ? "Each message of the stream" : "Response"} ·{" "}
              <Mono>{reference.messages[method.output]?.name ?? method.output}</Mono>
            </Typography>
            <Fields fullName={method.output} reference={reference} />
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

/** The messages and enums fields refer to (requests and responses are shown with their methods). */
function Types({ reference }: { reference: Reference }) {
  const shown = new Set(reference.services.flatMap((s) => s.methods.flatMap((m) => [m.input, m.output])));
  const messages = Object.entries(reference.messages)
    .filter(([fullName]) => !shown.has(fullName))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const enums = Object.entries(reference.enums).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        Types
      </Typography>
      <Stack spacing={2.5}>
        {messages.map(([fullName, message]) => (
          <Box key={fullName} id={anchor(fullName)} sx={{ scrollMarginTop: 80 }}>
            <Mono sx={{ fontWeight: 600 }}>{message.name}</Mono>
            <Box sx={{ mt: 0.5 }}>
              <Comment text={message.comment} />
            </Box>
            <Fields fullName={fullName} reference={reference} />
          </Box>
        ))}
        {enums.map(([fullName, e]) => (
          <Box key={fullName} id={anchor(fullName)} sx={{ scrollMarginTop: 80 }}>
            <Mono sx={{ fontWeight: 600 }}>{e.name}</Mono>{" "}
            <Typography component="span" variant="caption" color="text.secondary">
              one of
            </Typography>
            <Box sx={{ mt: 0.5 }}>
              <Comment text={e.comment} />
            </Box>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 3 }}>
              {e.values.map((v) => (
                <li key={v.name}>
                  <Mono>{v.name}</Mono>
                  {v.comment && (
                    <Typography component="span" variant="body2" color="text.secondary">
                      {" "}
                      — {v.comment.replaceAll("\n", " ")}
                    </Typography>
                  )}
                </li>
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

/** The console API, from the protos (proto/vennir/console/v1) it's built from. */
export function ApiReference() {
  const [reference, setReference] = useState<Reference | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Its own chunk: only this page needs it.
    import("../gen/api-reference.json")
      .then((module) => {
        setReference(module.default as Reference);
      })
      .catch(() => {
        setError("Couldn't load the API reference.");
      });
  }, []);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!reference) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={24} aria-label="Loading" />
      </Box>
    );
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
          API reference
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Everything the console does, its pages included, goes through this API. Each method is one URL,{" "}
          <Mono>POST /api/vennir.console.v1.&lt;Service&gt;/&lt;Method&gt;</Mono>, taking and returning JSON
          (the Connect protocol: plain HTTP, so curl works). Sign in with a bearer token: a session from{" "}
          <Mono>AuthService/Login</Mono>, or a bot's or automation token. A refusal answers{" "}
          <Mono>{'{"code": "permission_denied", "message": "…", "details": […]}'}</Mono>, with a stable code
          (such as <Mono>TEAM_RETIRED</Mono>) in its <Mono>Failure</Mono> detail.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Generated from the protos in the platform's repository (<Mono>proto/vennir/console/v1</Mono>), which
          are the contract: generate a typed client from them for any language, and call the same methods over
          gRPC or Connect as well as JSON.
        </Typography>
      </Box>
      {reference.services.map((service) => (
        <Box key={service.fullName}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {service.name}
          </Typography>
          <Box sx={{ color: "text.secondary" }}>
            <Comment text={service.comment} />
          </Box>
          <Stack spacing={1}>
            {service.methods.map((method) => (
              <MethodView key={method.name} service={service} method={method} reference={reference} />
            ))}
          </Stack>
        </Box>
      ))}
      <Types reference={reference} />
    </Stack>
  );
}
