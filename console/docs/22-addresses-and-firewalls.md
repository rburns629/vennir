# Addresses and firewall rules

Some targets let in only addresses they know: a database's authorized networks, a partner's firewall, a SaaS API's IP allowlist. And some callers can only reach addresses their own firewall allows. This page says which address each part of Vennir uses, how to find it, why the outbound ones aren't fixed on a cloud install, and what to do instead, or how to make them fixed when a firewall really needs it.

## Which address is which

**Leaving the cluster** (what a target sees):

| Traffic | Leaves from |
| --- | --- |
| A step calling a cloud API or a service | The node it runs on |
| The gateway calling an API's backend | The node the gateway runs on |
| The console sending notifications, chat webhooks and order callbacks, and pulling the catalog | The node the console runs on |

On every install `vennir` makes, that's the node's own address:

| Install | Outbound address |
| --- | --- |
| **kind** | Your machine's public address (or your network's) |
| **gcp** (GKE) | Each node's external IP. Nodes are added and removed as load changes, and replaced on upgrades, so the set changes |
| **aws** (EKS) | Each node's public IP: nodes sit in public subnets with no NAT gateway, which would cost more than a small install's nodes. The set changes the same way |
| **existing** | Whatever the cluster's network does: often a NAT gateway with a fixed address |

**Coming in** (what a caller or browser connects to):

| What | Address |
| --- | --- |
| The console, private | No address: `vennir console` reaches it through the Kubernetes API |
| The console, public on GKE | A reserved global address: fixed for the install's life (`vennir status` shows it) |
| The console, public on AWS | An Application Load Balancer's name. Its addresses change: give people the name |
| The gateway, in the cluster | `console-execution-console-gateway.vennir-system.svc.cluster.local`, reachable only from inside |
| The gateway, on the internet | Its Ingress's address ([the API gateway](21-api-gateway.md#putting-it-on-the-internet)) |

## Finding the outbound addresses now

**On kind**, from your machine:

```bash
curl -s https://checkip.amazonaws.com
```

**On GKE or EKS**, the nodes' external addresses:

```bash
kubectl get nodes -o wide          # the EXTERNAL-IP column
# or from the cloud:
gcloud compute instances list --project $PROJECT --filter="name~^gk3-|^gke-" --format="table(name,networkInterfaces[0].accessConfigs[0].natIP)"
aws ec2 describe-instances --region $REGION --filters "Name=tag:eks:cluster-name,Values=$CLUSTER" \
  --query "Reservations[].Instances[].PublicIpAddress" --output text
```

**To see what a target really sees**, run a one-off Pod that asks. Use a namespace of its own: team namespaces only run the catalog's images.

```bash
kubectl create namespace egress-check
kubectl -n egress-check run ip --rm -i --restart=Never --image=curlimages/curl -- curl -s https://checkip.amazonaws.com
kubectl delete namespace egress-check
```

Run it a few times, or on a busy install: different Pods land on different nodes, and get different answers.

## Why not just allow those addresses?

Because they change without notice. A node replaced during an upgrade, or a new one added for a burst of steps, has a new address, and runs that worked yesterday fail today with a connection timeout. And a node's address isn't Vennir's alone: every Pod on that node, every team's steps, leaves from it, so allowing it lets in more than the one product you meant.

## Use identity instead, where the target has it

Most cloud targets can check *who* is calling rather than *where from*, and each product already has an identity of its own. Prefer these:

| Target | Instead of an address allowlist |
| --- | --- |
| **Cloud SQL** | The Cloud SQL connectors or Auth Proxy (TLS, and IAM decides who connects), with IAM database sign-in; or a private IP in a VPC the cluster reaches. No authorized networks needed |
| **RDS** | IAM database authentication; in the cluster's VPC, a security group rule allowing the nodes' security group (a group, not addresses); from elsewhere, VPC peering or a private endpoint |
| **Cloud Run, Cloud Functions** | Require Google sign-in (`--no-allow-unauthenticated`), and grant `roles/run.invoker` to the product's principal or the gateway's invoker account |
| **Lambda function URLs, API Gateway** | `AuthType AWS_IAM`, with the role allowed to invoke |
| **Cloud Storage, S3, other cloud APIs** | IAM on the bucket or resource: addresses don't apply |
| **A backend behind the API gateway** | The gateway's own credential for it, or checking `Vennir-Caller` |
| **Your own service** | Accept a token: the step's own ServiceAccount token for an audience you choose (`tokenAudiences` in its `product.yaml`), checked against the cluster's issuer |

A third-party API that only knows addresses (some SaaS APIs, a partner's firewall) is what's left. For those, the cluster needs a fixed outbound address.

## Getting a fixed outbound address

`vennir` doesn't build one yet. On a cluster of your own (`vennir init --target existing`), the cloud's NAT gives every node one fixed address, or a few:

**Google Cloud**: Cloud NAT only translates nodes with no external IP, so the cluster needs private nodes, then:

```bash
gcloud compute addresses create vennir-egress --region $REGION --project $PROJECT
gcloud compute routers create vennir-router --network $NETWORK --region $REGION --project $PROJECT
gcloud compute routers nats create vennir-nat --router vennir-router --region $REGION --project $PROJECT \
  --nat-all-subnet-ip-ranges --nat-external-ip-pool vennir-egress
gcloud compute addresses describe vennir-egress --region $REGION --project $PROJECT --format='value(address)'
```

Adding Cloud NAT to the GKE cluster `vennir` makes changes nothing: its nodes have external IPs, which they keep using.

**AWS**: nodes in private subnets, whose route to the internet goes through a NAT gateway with an Elastic IP:

```bash
EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
NAT=$(aws ec2 create-nat-gateway --subnet-id $PUBLIC_SUBNET --allocation-id $EIP --query NatGateway.NatGatewayId --output text)
aws ec2 create-route --route-table-id $PRIVATE_ROUTE_TABLE --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT
```

A NAT gateway is billed by the hour and by the gigabyte, in each zone you put one in.

Then give the target that address. Every Pod in the cluster leaves from it, so it's still not one product's alone: keep the target's own sign-in on as well.

## Letting callers reach Vennir

When the people or systems calling Vennir sit behind a firewall of their own:

- **A public console on GKE**: allow its reserved address (`vennir status prod`, or `gcloud compute addresses list`). It stays the same until the install is destroyed.
- **A public console on AWS**: an Application Load Balancer has no fixed addresses. Allow its host name, through a proxy that resolves names, or put the console behind something that does have a fixed address (a Network Load Balancer with Elastic IPs, or AWS Global Accelerator); `vennir` doesn't make those.
- **The API gateway on the internet**: the address of whatever you put in front of it ([the API gateway](21-api-gateway.md#putting-it-on-the-internet)). On GKE, use a reserved address for it, as the console does.
- **A private console**: no firewall rule for the console itself. People reach it through `vennir console`, which needs the cluster's Kubernetes API endpoint.

## When a target refuses Vennir

| You see | Likely why | What to do |
| --- | --- | --- |
| A step times out connecting, or gets a connection refused, from one target only | The target allows only known addresses, and this node's isn't one | Use the target's identity-based access (above), or a fixed outbound address |
| It works on one run and not the next | Different nodes, different addresses: someone allowed one node's address | Remove that rule; use identity or a fixed address |
| Cloud SQL refuses a connection | No authorized network for the node, or the instance has only a private IP | The Cloud SQL connector or Auth Proxy, with IAM sign-in |
| RDS times out | Its security group doesn't allow the cluster, or it's in another VPC | Allow the nodes' security group, or peer the VPCs |
| A partner says requests come from an address they don't know | The cluster has no fixed outbound address | A fixed one, as above, then give them that |
