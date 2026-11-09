# Getting your computer ready

What the machine you run `vennir` from needs, on macOS, Linux and Windows.
`vennir` runs on macOS and Linux, on amd64 and arm64. On Windows it runs in
WSL 2, the Linux that Windows runs beside it: there is no Windows build.

`vennir tools --install` downloads kubectl, Helm, OpenTofu, kind and
kubelogin into `~/.vennir/bin`, each pinned and checked against its
project's checksum, and `vennir` uses them from there. What you install
yourself is Docker, your cloud's CLI, and for the catalog git and `gh`. `vennir tools --target
<target>` lists what's missing, with how to install it on your system.

| For | You install | `vennir tools --install` downloads |
| --- | --- | --- |
| Every install | | kubectl, Helm |
| kind (your laptop) | Docker, running, with about 4 GB of memory free | kind |
| Google Cloud | `gcloud`, `gke-gcloud-auth-plugin` | OpenTofu |
| AWS | `aws` CLI v2 | OpenTofu |
| Azure | `az` | OpenTofu, kubelogin |
| A cluster you have | a kubectl context that reaches it | |
| The catalog | git; `gh`, signed in with the `repo` and `workflow` scopes; Docker, to build and test products locally (`vennir catalog check`) | |
| Building from source (`--source`) | Docker | |

## macOS

1. **Docker** (for kind, or to build images): install [Docker
   Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)
   (or `brew install --cask docker-desktop`) and start it. For kind, check
   **Settings** → **Resources** leaves about 4 GB of memory free for it.
2. **`vennir`**: `arm64` on Apple silicon, `amd64` on Intel (`uname -m`
   says `arm64` or `x86_64`).

   ```bash
   V=0.14.0 P=darwin-arm64    # or darwin-amd64
   curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-$P"
   curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-checksums.txt"
   grep " vennir-$P\$" vennir-checksums.txt | shasum -a 256 -c -    # must say OK
   chmod +x "vennir-$P" && sudo mv "vennir-$P" /usr/local/bin/vennir
   vennir version
   ```

3. **The tools**: `vennir tools --target kind --install` (or `gcp`, `aws`,
   `azure`, `existing`).
4. **The CLIs**, with [Homebrew](https://brew.sh/):
   - git: `xcode-select --install` (or `brew install git`)
   - gh: `brew install gh`, then `gh auth login --scopes repo,workflow`
   - Google Cloud: `brew install --cask gcloud-cli`, then `gcloud components
     install gke-gcloud-auth-plugin`
   - AWS: `brew install awscli`
   - Azure: `brew install azure-cli`

## Linux

Any distribution on amd64 or arm64. The commands below are for Debian and
Ubuntu, with Fedora's where they differ.

1. **Docker** (for kind, or to build images): install Docker Engine from
   Docker's own repository ([Debian and
   Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
   [Fedora](https://docs.docker.com/engine/install/fedora/)). Docker Desktop
   isn't needed. Then start it, and let yourself use it without `sudo`, since
   `vennir` runs `docker` as you:

   ```bash
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"    # then sign out and back in
   docker info                        # works without sudo
   ```

   The `docker` group can do anything root can on this machine, which is
   what Docker needs on a computer of your own; don't add people to it on a
   shared one.

   kind's nodes watch many files. If its Pods fail with `too many open
   files`, raise the limits ([kind's known
   issues](https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files)):

   ```bash
   printf 'fs.inotify.max_user_watches = 524288\nfs.inotify.max_user_instances = 512\n' | sudo tee /etc/sysctl.d/99-kind.conf
   sudo sysctl --system
   ```

2. **`vennir`**: `uname -m` says `x86_64` (`amd64`) or `aarch64` (`arm64`).

   ```bash
   V=0.14.0 P=linux-amd64    # or linux-arm64
   curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-$P"
   curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-checksums.txt"
   grep " vennir-$P\$" vennir-checksums.txt | sha256sum -c -    # must say OK
   chmod +x "vennir-$P" && sudo mv "vennir-$P" /usr/local/bin/vennir
   vennir version
   ```

3. **The tools**: `vennir tools --target kind --install` (or `gcp`, `aws`,
   `azure`, `existing`).
4. **The CLIs**:
   - git: `sudo apt install git` (`sudo dnf install git`)
   - gh: from [GitHub's
     repository](https://github.com/cli/cli/blob/trunk/docs/install_linux.md),
     then `gh auth login --scopes repo,workflow`
   - Google Cloud: from [Google's
     repository](https://cloud.google.com/sdk/docs/install), with its
     `google-cloud-cli-gke-gcloud-auth-plugin` package
   - AWS: [AWS's
     installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
   - Azure: `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`
     ([Fedora](https://learn.microsoft.com/cli/azure/install-azure-cli-linux?pivots=dnf))

**With no browser** (a server over SSH): `gh auth login` and `az login`
print a code to enter on another machine (`az login --use-device-code` if it
doesn't), `gcloud auth login --no-browser` gives a command to run where
gcloud has a browser, and `aws login --remote` gives a link.

Tried on Ubuntu 24.04 (arm64, 2026-11-08) as above, as a user in the
`docker` group (in a container, so Docker was started without systemd): `vennir` 0.14.0 from the release, `vennir tools
--install`, and a kind install that answered on `localhost:18080`.

## Windows

`vennir` runs in WSL 2 with Ubuntu, where it's the Linux build: follow
[Linux](#linux) above, inside Ubuntu, with these differences.

1. **WSL 2 and Ubuntu**: in PowerShell as an administrator, `wsl --install`
   (it installs WSL 2 and Ubuntu), then restart and open **Ubuntu** from the
   Start menu. `wsl -l -v` in PowerShell should show Ubuntu at version 2.
2. **Docker**: install [Docker Desktop for
   Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
   with its WSL 2 backend, start it, and turn on **Settings** → **Resources**
   → **WSL integration** for Ubuntu. `docker info` in Ubuntu then works
   without `sudo`. (Docker Engine inside Ubuntu, as on Linux, works too.)
   WSL 2 gets half of Windows' memory by default; if kind runs short, raise
   it in `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   memory=8GB
   ```

   then `wsl --shutdown` in PowerShell and start Docker Desktop again.
3. **Work in Ubuntu's own files** (`~`), not on a Windows drive
   (`/mnt/c/...`). `vennir` keeps each environment's admin password and
   state in `deploy/<env>/`, readable only by you, and a Windows drive
   mounted in WSL ignores those permissions. A repository cloned from
   Windows may also have Windows line endings, which breaks a catalog's
   `./vennir` and its scripts. Clone in Ubuntu.
4. **The console** on `http://localhost:18080` (`vennir console`, or
   `make up` in a checkout) opens in Windows' browser: WSL 2 forwards
   `localhost`.
5. **Signing in**: when `gcloud`, `gh` or `az` can't open Windows' browser
   from Ubuntu, they print a link or a code to open there instead (`az login
   --use-device-code` if it doesn't).

Not yet tried on a Windows machine: these are WSL 2's and Docker Desktop's
own documented steps, with `vennir` as it runs on Linux.

## From a checkout of this repository

`make quickstart` (and the other `make` targets) runs kind, kubectl and Helm
from your `PATH`, with `make`, `curl` and git. `vennir tools --target kind
--install` downloads them into `~/.vennir/bin`; put that on your `PATH`
(`export PATH="$HOME/.vennir/bin:$PATH"` in `~/.zshrc` or `~/.bashrc`), or
on macOS `brew install kind kubectl helm`.
