// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { errorMessage, getTeamProfile, listApis, listRunnables, type ApiProduct, type Runnable, type TeamProfile } from "../../api";
import { Pill } from "../../components/Pill";
import { ReadinessPill } from "../../components/ReadinessPill";
import { runLink } from "../RunFormPage";

/** One of the team's templates or actions: what it is, whether it's yours to run, and how. */
function Offer({ r }: { r: Runnable }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.5, py: 1.25, borderTop: 1, borderColor: "divider", flexWrap: "wrap" }}>
      <Box sx={{ minWidth: 0, flex: "1 1 260px" }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {r.displayName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {/* An action by its own name: a product's actions share its display name. */}
          {r.kind === "action" ? (r.actions[0]?.split("/").pop() ?? "action") : "template"}
          {r.description && ` · ${r.description}`}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        {r.deprecated && (
          <Pill tone="warning" title={r.deprecated}>
            Deprecated
          </Pill>
        )}
        {r.readiness && <ReadinessPill readiness={r.readiness} />}
        {r.shared ? (
          <Button size="small" component={RouterLink} to={runLink(r)}>
            Run
          </Button>
        ) : r.askForAccessUrl ? (
          <Button size="small" href={r.askForAccessUrl} target="_blank" rel="noopener noreferrer">
            Ask for access ↗
          </Button>
        ) : (
          <Pill tone="neutral">Not shared with you</Pill>
        )}
      </Box>
    </Box>
  );
}

/**
 * A team as anyone signed in sees it: where to ask it, and what it offers
 * (its templates and actions, shared with you or not, their readiness, and
 * its APIs). The page for a team you're not in, and its members' "What it
 * offers" tab.
 */
export function TeamOffers({ teamName, showProfile }: { teamName: string; showProfile: boolean }) {
  const [profile, setProfile] = useState<TeamProfile | null>(null);
  const [offers, setOffers] = useState<Runnable[] | null>(null);
  const [apis, setApis] = useState<ApiProduct[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (showProfile) {
      getTeamProfile(teamName)
        .then(setProfile)
        .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the team.")); });
    }
    listRunnables()
      .then((all) => { setOffers(all.filter((r) => r.team === teamName)); })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load what it offers.")); });
    // Display only: without it, no APIs are listed.
    listApis()
      .then((all) => { setApis(all.filter((a) => a.team === teamName)); })
      .catch(() => undefined);
  }, [teamName, showProfile]);

  const templates = (offers ?? []).filter((r) => r.kind === "template");
  const actions = (offers ?? []).filter((r) => r.kind === "action");
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {error && <Alert severity="error">{error}</Alert>}
      {profile && (
        <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="h6" component="h2">
            Asking {teamName}
          </Typography>
          {profile.retired && <Alert severity="warning">{teamName} is retired: what it offers no longer runs.</Alert>}
          {profile.description && <Typography variant="body2">{profile.description}</Typography>}
          <Typography variant="body2">
            {profile.people} {profile.people === 1 ? "person" : "people"}
            {profile.fromCatalog ? ", from the catalog" : ""}.
            {profile.owner && <> Owned in the catalog by {profile.owner}.</>}
            {profile.contact && <> Contact: {profile.contact}.</>}
          </Typography>
          {(profile.helpChat ?? profile.helpUrl) && (
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              {profile.helpChat && (
                <Link href={profile.helpChat} target="_blank" rel="noopener noreferrer" variant="body2">
                  Its chat ↗
                </Link>
              )}
              {profile.helpUrl && (
                <Link href={profile.helpUrl} target="_blank" rel="noopener noreferrer" variant="body2">
                  Its help page ↗
                </Link>
              )}
            </Box>
          )}
          {!profile.contact && !profile.helpChat && !profile.helpUrl && (
            <Typography variant="body2" color="text.secondary">
              Its team.yaml says nowhere to ask: an admin can tell you who&apos;s in it.
            </Typography>
          )}
        </Card>
      )}
      {[
        { title: "Templates", items: templates },
        { title: "Actions", items: actions },
      ].map(({ title, items }) => (
        <Card key={title} sx={{ p: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            {title}
          </Typography>
          {offers === null ? (
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          ) : items.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              None you can see.
            </Typography>
          ) : (
            items.map((r) => <Offer key={`${r.kind}:${r.name}`} r={r} />)
          )}
        </Card>
      ))}
      {apis.length > 0 && (
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            APIs
          </Typography>
          {apis.map((a) => (
            <Box key={a.name} sx={{ py: 1, borderTop: 1, borderColor: "divider" }}>
              <Link component={RouterLink} to={`/apis/${encodeURIComponent(a.team)}/${encodeURIComponent(a.name)}`} variant="body2">
                {a.displayName}
              </Link>
              {a.description && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {a.description}
                </Typography>
              )}
            </Box>
          ))}
        </Card>
      )}
    </Box>
  );
}
