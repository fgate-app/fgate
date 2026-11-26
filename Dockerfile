# syntax=docker/dockerfile:1
FROM node:26.8.1-trixie@sha256:f5d1cc40abc10c2843339a2134d07817cf33c405cb16bfd052b0ed790254c3a3 AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY shared ./shared
RUN npm run build

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS modules-build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make gcc g++ pkg-config libnetfilter-queue-dev libcap-dev zlib1g-dev libmnl-dev libnfnetlink-dev liblua5.4-dev libluajit-5.1-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY packaging ./packaging
COPY scripts ./scripts
COPY server/outline ./server/outline
COPY server/lantern/upstream.go ./server/lantern/upstream.go
COPY server/lantern/source ./server/lantern/source
RUN python3 scripts/fetch-runtime.py go --platform linux-${TARGETARCH} --output /opt/go
ENV PATH="/opt/go/bin:${PATH}"
RUN python3 scripts/release-bundles.py --platform linux-${TARGETARCH} --prepare
RUN case "$TARGETARCH" in arm64|amd64) ;; *) echo "Only linux/arm64 and linux/amd64 are supported." >&2; exit 1;; esac \
 && python3 scripts/prepare-modules.py --platform linux-${TARGETARCH} --output /modules \
 && printf "linux-%s\n" "$TARGETARCH" > /modules/.platform
COPY server/access-points/assets.json ./server/access-points/assets.json
RUN python3 scripts/fetch-access-modules.py --platform linux-arm64 --platform linux-amd64

# systemd is PID 1: preserve the same privilege boundary, journald and lifecycle
# as native installation. Full gateway containers require a Linux Docker host.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
ARG TARGETARCH
ENV container=docker
STOPSIGNAL SIGRTMIN+3
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates openssh-client curl python3 xz-utils hostapd dnsmasq-base nftables iproute2 iw rfkill procps iputils-ping kmod libnetfilter-queue1 libnfnetlink0 libmnl0 libcap2 liblua5.4-0 libluajit-5.1-2 zlib1g && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home-dir /var/lib/freedomgate --shell /usr/sbin/nologin freedomgate \
 && install -d -m 0700 -o freedomgate -g freedomgate /var/lib/freedomgate \
 && install -d /opt/freedomgate/module-updates /etc/freedomgate
COPY --from=web-build /usr/local /opt/freedomgate/runtime/node
WORKDIR /opt/freedomgate/current
COPY package.json package-lock.json ./
COPY server ./server
COPY shared ./shared
COPY --from=web-build /build/node_modules/yaml ./node_modules/yaml
COPY scripts ./scripts
COPY packaging ./packaging
COPY --from=web-build /build/web/dist ./web/dist
COPY --from=web-build /build/web/src ./web/src
COPY --from=web-build /build/web/public ./web/public
COPY --from=modules-build /modules /opt/freedomgate/module-seed
COPY --from=modules-build /build/server/access-points/bin ./server/access-points/bin
COPY --from=modules-build /build/server/outline/bin ./server/outline/bin
COPY --from=modules-build /build/server/lantern/bin ./server/lantern/bin
COPY --from=modules-build /build/server/tor/bin ./server/tor/bin
COPY --from=modules-build /build/packaging/release-bundles ./packaging/release-bundles
RUN python3 scripts/release-bundles.py --platform linux-${TARGETARCH} \
 && install -m 0644 packaging/systemd/*.service /etc/systemd/system/ \
 && systemctl enable freedomgate-network.service freedomgate.service \
 && systemctl mask getty.target console-getty.service systemd-logind.service systemd-remount-fs.service systemd-udevd.service systemd-udev-trigger.service systemd-sysctl.service systemd-modules-load.service \
 && mkdir -p /etc/systemd/system/freedomgate.service.d \
 && printf '[Service]\nEnvironment=PORT=80\n' > /etc/systemd/system/freedomgate.service.d/container.conf \
 && mkdir -p /etc/systemd/system/freedomgate-network.service.d \
 && printf '[Service]\nEnvironment=FREEDOMGATE_CONTAINER=1\n' > /etc/systemd/system/freedomgate-network.service.d/container.conf \
 && rm -f /etc/machine-id && touch /etc/machine-id
VOLUME ["/var/lib/freedomgate", "/opt/freedomgate/modules", "/opt/freedomgate/module-updates"]
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=10s --start-period=45s CMD /opt/freedomgate/runtime/node/bin/node scripts/install-health.mjs || exit 1
ENTRYPOINT ["/bin/sh", "/opt/freedomgate/current/scripts/container-entrypoint.sh"]
CMD ["/sbin/init"]
