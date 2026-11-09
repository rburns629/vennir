# Lab 7: APIs on every cloud, through the gateway

**Goal:** put the gateway of your GKE install on the internet, publish one backend on AWS (ECS Express) and one on Azure (a Container App behind Microsoft Entra sign-in), and call both through the gateway, with the gateway signing in to each backend itself and nothing stored. **Time:** about an hour and a half. **Cost:** billed, small: GKE's load balancer and a reserved address (a few cents an hour), the ECS service, the Container App, an Azure container registry (about $0.17 a day). **You need:** [Lab 3](lab-3-gke.md)'s install, with the gateway on (`--gateway true`); [Lab 5](lab-5-aws-from-gke.md)'s AWS setup and [Lab 6](lab-6-azure-from-gke.md)'s Azure setup, in the same shell (its `principal`, `client` and `$ISSUER`). The Azure API needs a catalog from a release after 0.15.0, whose samples have `samples/azure/apis/greetings` and its template's `registryServer` and `registryIdentity`.

The reasons behind each step are in [the API gateway](21-api-gateway.md). Proven exactly this way on 2026-11-09, from the 0.15.0 release.

## 1. The gateway on the internet

The backends check every request's `Vennir-Caller` signature against the gateway's public keys, which only its internet listener serves. Reserve an address, and write `deploy/lab/gateway-public.yaml`:

```bash
gcloud compute addresses create vennir-lab-gateway --global --project <project>
IP=$(gcloud compute addresses describe vennir-lab-gateway --global --project <project> --format='value(address)')
```

```yaml
gateway:
  publicListener: true
  publicUrl: https://<IP>.nip.io
  ingress:
    enabled: true
    host: <IP>.nip.io
    gke: true
    annotations:
      kubernetes.io/ingress.class: gce
      kubernetes.io/ingress.global-static-ip-name: vennir-lab-gateway
      kubernetes.io/ingress.allow-http: "false"
  publicListenerFrom:
    - ipBlock: {cidr: 35.191.0.0/16}
    - ipBlock: {cidr: 130.211.0.0/22}
  trustedProxies: ["35.191.0.0/16", "130.211.0.0/22", "<IP>/32"]
```

```bash
vennir config set -e lab values gateway-public.yaml
vennir config set -e lab gateway.backendHosts '*.ecs.us-east-2.on.aws,*.centralus.azurecontainerapps.io'
vennir config set -e lab gateway.internetTeams 'aws,azure'
vennir apply lab
```

`<IP>.nip.io` resolves to the address, so Google can issue its certificate with no DNS record of yours.

**Check:** within about 20 minutes, `curl https://<IP>.nip.io/.vennir/jwks.json` answers 200 with the gateway's public key.

## 2. The AWS API

Run Lab 5's `greetings-backend` again (or for the first time) with `gatewayKeys: https://<IP>.nip.io/.vennir/jwks.json`, and read its `serviceUrl`. In your catalog: `cp -R samples/aws/apis/greetings teams/aws/apis/greetings`; put the `serviceUrl` in its `api.yaml`'s `backend.url` and its `openapi.yaml`'s `servers`, and add `reachable: internet` to `api.yaml`.

It has no `auth`: ECS Express's URL is public and takes no signature, so the backend checks the gateway's signature on every request instead.

## 3. The Azure API

Three things in the tenant, once:

```bash
# The backend's app registration: its client id is the audience the gateway's tokens carry.
APP=$(az ad app create --display-name vennir-lab-greetings --query appId -o tsv)
az ad app update --id $APP --identifier-uris "api://$APP"
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications(appId='$APP')" \
  --headers Content-Type=application/json --body '{"api":{"requestedAccessTokenVersion":2}}'
az ad sp create --id $APP

# The gateway's identity for this API, trusting the API's ServiceAccount (the console makes it: greetings-api).
az identity create -n greetings-gateway -g vennir-lab-identities -l centralus
az identity federated-credential create --name vennir-lab --identity-name greetings-gateway -g vennir-lab-identities \
  --issuer "$ISSUER" --subject system:serviceaccount:azure:greetings-api --audiences api://AzureADTokenExchange

# A registry, and the identity the app pulls with.
ACR=vennirlab$(openssl rand -hex 3)
az acr create -n $ACR -g vennir-lab-identities -l centralus --sku Basic --admin-enabled false
az identity create -n greetings-pull -g vennir-lab-identities -l centralus
PULL=$(az identity show -n greetings-pull -g vennir-lab-identities --query id -o tsv)
az role assignment create --assignee-object-id $(principal greetings-pull) --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope $(az acr show -n $ACR --query id -o tsv)
az role assignment create --assignee-object-id $(principal azure-container-app) --assignee-principal-type ServicePrincipal \
  --role "Managed Identity Operator" --scope $PULL
az acr login -n $ACR
docker buildx build --platform linux/amd64 -t $ACR.azurecr.io/greetings:1 --push examples/greetings-api
```

Then **Catalog → greetings-backend (azure) → Run**, for `azure`: the subscription, `resourceGroup: lab`, `location: centralus`, `image: <ACR>.azurecr.io/greetings:1`, `registryServer: <ACR>.azurecr.io`, `registryIdentity: <PULL>`, `gatewayKeys: https://<IP>.nip.io/.vennir/jwks.json`, `tenantId`, `backendClientId: <APP>`, `gatewayClientId: $(client greetings-gateway)`. Read the `app` step's `url`.

In your catalog: `cp -R samples/azure/apis/greetings teams/azure/apis/greetings`; put that URL in `api.yaml` and `openapi.yaml`, your tenant, the gateway identity's client id and `api://<APP>/.default` in its `entraToken`, and add `reachable: internet`. Open the pull request for both APIs and merge it once CI passes.

**Check:** **APIs** lists `aws/greetings` and `azure/greetings`, both **Live**, each with its public URL.

## 4. Call them

You're a member of both teams, so your own session may call. For a script, a bot's token from a team's **Automation** tab works the same way.

```bash
read -rs PW && TOKEN=$(jq -n --arg e <your email> --arg p "$PW" '{email: $e, password: $p}' \
  | curl -s -X POST http://localhost:18080/api/vennir.console.v1.AuthService/Login -H 'Content-Type: application/json' -d @- | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" "https://<IP>.nip.io/aws/greetings/greetings/World?style=shout"
curl -H "Authorization: Bearer $TOKEN" "https://<IP>.nip.io/azure/greetings/greetings/World?style=shout"
```

**Check:** both answer `{"message":"HELLO, WORLD!", "team": …}`. The Azure one's first call can answer 504 `BACKEND_TIMEOUT`: the Container App scaled to zero and took longer than the API's ten seconds to start. The next call answers in well under a second.

## 5. Try to get around it

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://<IP>.nip.io/azure/greetings/greetings/World"                       # 401: no caller
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "https://<IP>.nip.io/azure/greetings/healthz"   # 404: not in the OpenAPI file
curl -s -o /dev/null -w '%{http_code}\n' https://<the Container App's URL>/greetings/World                             # 401: Azure wants an Entra token
curl -s https://<the ECS serviceUrl>/greetings/World                                                                    # 401: no gateway signature
```

**Check:** every one is refused. The gateway forwards only what each API's OpenAPI file describes, to callers its access list allows; each backend answers only the gateway.

## Clean up

Take the APIs out of the catalog (a pull request removing both `apis/` folders), then delete their backends: the ECS service as in Lab 5, and `az group delete -n lab --yes` for the Container App. Delete the app registration (`az ad app delete --id $APP`) and the registry with the identities group (Lab 6's clean up).

Before `vennir destroy lab`, delete the gateway's Ingress and certificate, and wait for Google to remove the load balancer's endpoint groups, or the network's delete fails:

```bash
kubectl --context gke_<project>_us-east1_vennir-lab -n vennir-system delete ingress console-execution-console-gateway
kubectl --context gke_<project>_us-east1_vennir-lab -n vennir-system delete managedcertificate console-execution-console-gateway
gcloud compute network-endpoint-groups list --project <project>      # until it's empty, a few minutes
vennir destroy lab --all
gcloud compute addresses delete vennir-lab-gateway --global --project <project>
```

## What you proved

One gateway on GKE serving APIs whose backends run on two other clouds: signing in to Azure as its own identity by federation (`entraToken`), signing every caller's identity into each request for the backend to check, forwarding only what the API describes, and stored keys nowhere.
