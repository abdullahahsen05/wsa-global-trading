#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git unzip

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

if ! command -v aws >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64) aws_arch="x86_64" ;;
    aarch64) aws_arch="aarch64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

if ! id wsa >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash wsa
fi

install -d -o wsa -g wsa /opt/wsa
if [[ ! -d /opt/wsa/app/.git ]]; then
  sudo -u wsa git clone --depth 1 --branch main \
    https://github.com/abdullahahsen05/wsa-global-trading.git \
    /opt/wsa/app
fi

cd /opt/wsa/app
sudo -u wsa git fetch origin main
sudo -u wsa git reset --hard origin/main
sudo -u wsa npm ci --omit=dev

# Keep enough headroom for the three Node/MetaApi workers during reconnect bursts.
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 0644 deploy/aws/wsa-background-worker.service /etc/systemd/system/
install -m 0644 deploy/aws/wsa-copy-worker.service /etc/systemd/system/
install -m 0644 deploy/aws/wsa-risk-worker.service /etc/systemd/system/

mkdir -p /var/log/journal
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable --now wsa-background-worker wsa-copy-worker wsa-risk-worker

if systemctl list-unit-files amazon-ssm-agent.service >/dev/null 2>&1; then
  systemctl enable --now amazon-ssm-agent
fi
