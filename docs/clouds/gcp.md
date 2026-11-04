# Getting Google Cloud ready for Vennir

What only the Google Cloud website can do, before `vennir init`. `init`
checks the rest (which account is signed in, OpenTofu's sign-in, the
project and its organization's policies) and links back here.

## A project, with billing

Vennir creates a cluster, a network, identities, registries and a bucket in
one project. A **project of its own** is safest:

1. <https://console.cloud.google.com/projectcreate> → a name such as
   `acyclix-dev`.
2. **Billing** → link a billing account.

`init` lists the projects you can use, and says when the one you pick
already holds clusters or networks.

## Sign in

Two sign-ins, often confused:

```
gcloud auth login                       # gcloud itself
gcloud auth application-default login   # what OpenTofu uses
```

Both should be the same account. With several accounts signed in, gcloud
uses the *active* one (`gcloud config set account <email>` to change);
`init` lets you choose, and warns when OpenTofu's sign-in is a different
account.

GKE also needs gcloud's `gke-gcloud-auth-plugin`
(`gcloud components install gke-gcloud-auth-plugin`); vennir finds it
in gcloud's own folder even when it isn't on your PATH.

## Organization policies

A project in an organization may be limited by its policies. `init` checks
two that stop an install:

- **Resource locations** (`gcp.resourceLocations`): choose a region it
  allows. vennir reads regions and the groups named after them
  (`in:us-locations`, `in:europe-locations`…). For a group named after a
  jurisdiction (`in:eu-locations`, `in:japan-locations`…), it says it can't
  tell rather than refusing, and the apply stops if Google refuses.
- **External IPs for VMs** (`compute.vmExternalIpAccess`): GKE's nodes then
  need private nodes and Cloud NAT, which the module doesn't make yet.

## Next

[Setting up Vennir](../setup.md): `vennir init`, what each question decides, and what to expect from `vennir apply`.
