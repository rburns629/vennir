// SPDX-License-Identifier: MIT

package tools

// Pin is a downloadable tool's pinned version and published checksums.
type Pin struct {
	Version string
	// URL with {os}, {arch} and {version}.
	URL string
	// Member, for an archive (.tar.gz, or .zip by its URL): the binary's
	// path inside it.
	Member string
	// SHA256 per "os/arch", from the project's own checksum files.
	SHA256 map[string]string
}

// The tools vennir may download. To upgrade one: change its version and
// take the four sums from the release's published checksums (kubectl:
// dl.k8s.io/release/<v>/bin/<os>/<arch>/kubectl.sha256; helm:
// get.helm.sh/helm-<v>-<os>-<arch>.tar.gz.sha256sum; kind: the release's
// kind-<os>-<arch>.sha256sum; tofu: the release's tofu_<v>_SHA256SUMS;
// kubelogin: the release's kubelogin-<os>-<arch>.zip.sha256).
// Pick releases at least two weeks old.
var pins = map[string]Pin{
	"kubectl": {
		Version: "1.37.1",
		URL:     "https://dl.k8s.io/release/v{version}/bin/{os}/{arch}/kubectl",
		SHA256: map[string]string{
			"darwin/amd64": "6851381c486ff6edd691623e3d65c87cb9a5b02887ff8fbbb38d8a031b748387",
			"darwin/arm64": "fd65982c97ddad3106754b69ffa196d0e543aa591930ae52aed1adfb92f8c77f",
			"linux/amd64":  "65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8",
			"linux/arm64":  "ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7",
		},
	},
	"helm": {
		Version: "4.3.0",
		URL:     "https://get.helm.sh/helm-v{version}-{os}-{arch}.tar.gz",
		Member:  "{os}-{arch}/helm",
		SHA256: map[string]string{
			"darwin/amd64": "347a784877e0e20eac865e8d1c36a80f6bb0861d6f29abd34defb6570ef95d92",
			"darwin/arm64": "d3870437e1e95b67f8edbde964156c84a26503f560821d40c542441658934fba",
			"linux/amd64":  "86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb",
			"linux/arm64":  "31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08",
		},
	},
	"tofu": {
		Version: "1.13.1",
		URL:     "https://github.com/opentofu/opentofu/releases/download/v{version}/tofu_{version}_{os}_{arch}.tar.gz",
		Member:  "tofu",
		SHA256: map[string]string{
			"darwin/amd64": "a73720443ba38712d7d96dc1e857add02c15a790919c653ad07492e9952f8c27",
			"darwin/arm64": "be78f659f04ef06a9dbd9b3934d46af95d787a3aa38396d459dea395261816a9",
			"linux/amd64":  "378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69",
			"linux/arm64":  "9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3",
		},
	},
	// AKS's kubectl sign-in (Microsoft Entra), as the az CLI's own.
	"kubelogin": {
		Version: "0.2.22",
		URL:     "https://github.com/Azure/kubelogin/releases/download/v{version}/kubelogin-{os}-{arch}.zip",
		Member:  "bin/{os}_{arch}/kubelogin",
		SHA256: map[string]string{
			"darwin/amd64": "6f4a17811e5d5815bb005daae5dabce3d016c2caac84a097f1db4263344f113e",
			"darwin/arm64": "b586d6409d578f2048053a6117ace47f0154f36c5beb6792c674679987a7efc8",
			"linux/amd64":  "716cbcb1880bca8f0e976b8917d06fcfe04de2c1e737eaaabbb26e2782330119",
			"linux/arm64":  "306a31d80af443d06fb71e04d2feaf65a6c9cf2e7e806e87b895b77fe2093ea6",
		},
	},
	"kind": {
		Version: "0.33.0",
		URL:     "https://github.com/kubernetes-sigs/kind/releases/download/v{version}/kind-{os}-{arch}",
		SHA256: map[string]string{
			"darwin/amd64": "5a99f26f57246dc9319dd294803313197a0f34d33c525b3ea8b655db5916ece0",
			"darwin/arm64": "0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f",
			"linux/amd64":  "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d",
			"linux/arm64":  "20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2",
		},
	},
}

// Pinned returns a tool's pinned version, if vennir can download it.
func Pinned(tool string) (string, bool) {
	p, ok := pins[tool]
	return p.Version, ok
}

// ChartPin is a third-party Helm chart's pinned version and the SHA-256 of
// its package (the .tgz `helm pull` fetches).
type ChartPin struct {
	Repo    string
	Version string
	SHA256  string
}

// The third-party charts vennir installs, each checked against its sum
// before Helm installs it (PullChart). To upgrade one: change its version,
// then `helm pull <chart> --repo <repo> --version <v>` and take the .tgz's
// `shasum -a 256`. Pick releases at least two weeks old.
var charts = map[string]ChartPin{
	"metrics-server": {
		Repo:    "https://kubernetes-sigs.github.io/metrics-server/",
		Version: "3.14.0",
		SHA256:  "c2ca1185c01e6e7f53dd1b7d131f0c9b3fa50e003ed068b784563a1b5a3422a1",
	},
	"cert-manager": {
		Repo:    "https://charts.jetstack.io",
		Version: "v1.21.2",
		SHA256:  "73a56e1728edd6c99f1f31082618c3259d279a76b7ebd3d4bdc5475c2442d34a",
	},
	"external-secrets": {
		Repo:    "https://charts.external-secrets.io",
		Version: "2.10.0",
		SHA256:  "b96e948fff3674638b5d3f9e43886f3796e04739c4b4127929aed2ddac7d1418",
	},
	"policy-controller": {
		Repo:    "https://sigstore.github.io/helm-charts",
		Version: "0.10.8",
		SHA256:  "71ecc9f1168dd7ad04b2f7456c2d492b5ca3e09a31883bb71f6369213ceeb814",
	},
	"cluster-autoscaler": {
		Repo:    "https://kubernetes.github.io/autoscaler",
		Version: "9.59.0",
		SHA256:  "90276dafe65cf5d4328ef8313baf6cfb9d130683e0c9f3c28a03b4d8a9ed8f6e",
	},
}

// ChartVersion returns a pinned chart's version.
func ChartVersion(chart string) string {
	p, ok := charts[chart]
	if !ok {
		panic("no pinned chart " + chart)
	}
	return p.Version
}
