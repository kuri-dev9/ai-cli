#!/usr/bin/env bash
#
# AI-CLI 로컬 HTTPS 인증서 생성
#
#   ./scripts/generate-cert.sh                 # LAN IP 를 자동으로 찾아 인증서 생성
#   ./scripts/generate-cert.sh 192.168.0.42    # 넣을 IP/호스트를 직접 지정 (여러 개 가능)
#   ./scripts/generate-cert.sh --openssl       # mkcert 가 깔려 있어도 openssl 로 만들기
#   ./scripts/generate-cert.sh --force         # 이미 있는 인증서를 덮어쓰기
#
# 만들어지는 것: certs/server.key, certs/server.crt  (둘 다 .gitignore 대상)
#
# SAN(Subject Alternative Name)에 localhost + 127.0.0.1 + LAN IP 를 모두 넣는다.
# 폰에서 https://192.168.x.x 로 붙을 때 CN 이 아니라 SAN 을 보기 때문에,
# LAN IP 가 빠지면 인증서를 신뢰 목록에 넣어도 "이 서버가 아니다" 오류가 난다.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; DIM=$'\033[2m'; NC=$'\033[0m'
info() { printf "%s[INFO]%s %s\n" "$BLUE"   "$NC" "$1"; }
ok()   { printf "%s[OK]%s %s\n"   "$GREEN"  "$NC" "$1"; }
warn() { printf "%s[경고]%s %s\n" "$YELLOW" "$NC" "$1"; }
fail() { printf "%s[실패]%s %s\n" "$RED"    "$NC" "$1" >&2; exit 1; }

CERT_DIR="certs"
KEY_FILE="$CERT_DIR/server.key"
CRT_FILE="$CERT_DIR/server.crt"

FORCE=0
USE_MKCERT=auto
EXTRA_NAMES=()

for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --openssl) USE_MKCERT=no ;;
    --mkcert)  USE_MKCERT=yes ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        fail "알 수 없는 옵션: $arg" ;;
    *)         EXTRA_NAMES+=("$arg") ;;
  esac
done

if [ -f "$KEY_FILE" ] && [ -f "$CRT_FILE" ] && [ "$FORCE" -eq 0 ]; then
  warn "인증서가 이미 있습니다: $CRT_FILE"
  warn "다시 만들려면: ./scripts/generate-cert.sh --force"
  exit 0
fi

# ---------------------------------------------------------------- LAN IP 찾기
#
# 0.0.0.0 으로 바인딩해도 폰은 맥의 실제 LAN 주소로 붙는다. 그 주소가 SAN 에 있어야 한다.
detect_lan_ips() {
  case "$(uname -s)" in
    Darwin)
      # 활성 인터페이스를 전부 훑는다. 유선(en0)만 보면 Wi-Fi 를 놓칠 수 있다.
      for iface in $(ifconfig -l 2>/dev/null); do
        case "$iface" in lo*|utun*|awdl*|llw*|bridge*|gif*|stf*) continue ;; esac
        ipconfig getifaddr "$iface" 2>/dev/null || true
      done
      ;;
    Linux)
      if command -v hostname >/dev/null 2>&1; then
        hostname -I 2>/dev/null | tr ' ' '\n' || true
      fi
      if command -v ip >/dev/null 2>&1; then
        ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' || true
      fi
      ;;
  esac
}

LAN_IPS=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in 127.*) continue ;; esac
  # 중복 제거
  for seen in ${LAN_IPS[@]+"${LAN_IPS[@]}"}; do
    [ "$seen" = "$line" ] && continue 2
  done
  LAN_IPS+=("$line")
done < <(detect_lan_ips)

# 직접 지정한 이름을 합친다 (IP 든 호스트명이든)
ALL_NAMES=(localhost)
# 맥의 hostname 이 IP 로 잡혀 있는 경우가 있다 (`hostname -s` 가 "192" 를 돌려준다).
# 글자로 시작하는 진짜 호스트명일 때만 SAN 에 넣는다.
HOST_SHORT="$(hostname -s 2>/dev/null || true)"
if printf '%s' "$HOST_SHORT" | grep -Eq '^[A-Za-z][A-Za-z0-9-]*$' && [ "$HOST_SHORT" != "localhost" ]; then
  ALL_NAMES+=("$HOST_SHORT" "$HOST_SHORT.local")
fi
ALL_NAMES+=(${LAN_IPS[@]+"${LAN_IPS[@]}"} ${EXTRA_NAMES[@]+"${EXTRA_NAMES[@]}"})

if [ ${#LAN_IPS[@]} -eq 0 ] && [ ${#EXTRA_NAMES[@]} -eq 0 ]; then
  warn "LAN IP 를 찾지 못했습니다. localhost 전용 인증서가 만들어집니다."
  warn "폰에서 쓰려면 IP 를 직접 넣으세요:  ./scripts/generate-cert.sh 192.168.0.42"
fi

printf "\n"
info "인증서에 넣을 이름:"
for n in "${ALL_NAMES[@]}"; do printf "    %s\n" "$n"; done
printf "\n"

mkdir -p "$CERT_DIR"

# ---------------------------------------------------------------- mkcert 경로
#
# mkcert 는 로컬 CA 로 서명해 준다. 그 CA 를 맥과 폰에 한 번 설치하면
# 브라우저 경고가 완전히 사라지고, service worker / PWA 설치도 정상 동작한다.
# 자체 서명 인증서로는 이게 안 된다 (아래 참고 메시지).
if [ "$USE_MKCERT" != "no" ] && command -v mkcert >/dev/null 2>&1; then
  info "mkcert 를 사용합니다 (로컬 CA 로 서명 — 경고 없음)"
  mkcert -install
  mkcert -key-file "$KEY_FILE" -cert-file "$CRT_FILE" "${ALL_NAMES[@]}" 127.0.0.1 ::1
  chmod 600 "$KEY_FILE"
  CA_ROOT="$(mkcert -CAROOT)"
  ok "인증서 생성 완료"
  printf "\n"
  printf "%s폰/태블릿에서 경고 없이 쓰려면:%s\n" "$YELLOW" "$NC"
  printf "  1. 이 파일을 기기로 보냅니다 (AirDrop, 메일 등):\n"
  printf "     %s%s/rootCA.pem%s\n" "$BLUE" "$CA_ROOT" "$NC"
  printf "  2. iOS: 열어서 프로파일 설치 → %s설정 > 일반 > 정보 > 인증서 신뢰 설정%s 에서 켜기\n" "$DIM" "$NC"
  printf "     Android: %s설정 > 보안 > 인증서 설치 > CA 인증서%s\n" "$DIM" "$NC"
  printf "  3. 설치하지 않으면 자체 서명과 똑같이 경고가 뜹니다.\n\n"
  MADE_WITH=mkcert
else
  # ------------------------------------------------------------- openssl 경로
  command -v openssl >/dev/null 2>&1 || fail "openssl 이 없습니다. 설치 후 다시 실행하세요."

  if [ "$USE_MKCERT" = "yes" ]; then
    fail "mkcert 가 PATH 에 없습니다.  macOS: brew install mkcert"
  fi

  info "openssl 로 자체 서명 인증서를 만듭니다"

  CNF="$(mktemp -t aicli-cert-XXXXXX)"
  trap 'rm -f "$CNF"' EXIT

  {
    printf '[req]\n'
    printf 'distinguished_name = dn\n'
    printf 'x509_extensions = v3_req\n'
    printf 'prompt = no\n'
    printf '\n[dn]\n'
    printf 'CN = AI-CLI Local\n'
    printf '\n[v3_req]\n'
    printf 'basicConstraints = critical, CA:FALSE\n'
    printf 'keyUsage = critical, digitalSignature, keyEncipherment\n'
    printf 'extendedKeyUsage = serverAuth\n'
    printf 'subjectAltName = @alt_names\n'
    printf '\n[alt_names]\n'
    dns_i=0; ip_i=0
    # SAN 에 DNS 와 IP 를 구분해서 넣는다. IP 를 DNS 항목으로 넣으면 브라우저가 무시한다.
    for n in "${ALL_NAMES[@]}"; do
      if printf '%s' "$n" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        ip_i=$((ip_i + 1)); printf 'IP.%d = %s\n' "$ip_i" "$n"
      else
        dns_i=$((dns_i + 1)); printf 'DNS.%d = %s\n' "$dns_i" "$n"
      fi
    done
    ip_i=$((ip_i + 1)); printf 'IP.%d = 127.0.0.1\n' "$ip_i"
    ip_i=$((ip_i + 1)); printf 'IP.%d = ::1\n' "$ip_i"
  } > "$CNF"

  # 397일: Apple 은 TLS 서버 인증서의 유효기간이 398일을 넘으면 Safari/iOS 에서
  # 거부한다. 넉넉하게 10년으로 만들면 맥에서는 되는데 폰에서만 안 되는,
  # 원인을 찾기 아주 어려운 실패가 생긴다.
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout "$KEY_FILE" -out "$CRT_FILE" \
    -days 397 -config "$CNF" -extensions v3_req >/dev/null 2>&1 \
    || fail "openssl 인증서 생성에 실패했습니다."

  chmod 600 "$KEY_FILE"
  ok "자체 서명 인증서 생성 완료 (유효기간 397일)"
  printf "\n"
  printf "%s자체 서명이라 이런 대가가 따릅니다:%s\n" "$YELLOW" "$NC"
  printf "  - 접속할 때마다 브라우저 경고를 통과해야 합니다\n"
  printf "  - %sservice worker 가 등록되지 않습니다%s — 오프라인 캐시, 웹 푸시 알림,\n" "$YELLOW" "$NC"
  printf "    홈 화면 PWA 설치가 동작하지 않습니다 (브라우저가 인증서 오류 페이지를 막습니다)\n"
  printf "  - 경고 없이 쓰고 PWA 도 살리려면 mkcert 를 쓰세요:\n"
  printf "      %sbrew install mkcert && ./scripts/generate-cert.sh --force%s\n" "$BLUE" "$NC"
  printf "  - 또는 %s%s%s 를 폰에 설치해 신뢰 인증서로 등록하세요\n\n" "$BLUE" "$CRT_FILE" "$NC"
  MADE_WITH=openssl
fi

printf "%s===============================================%s\n" "$DIM" "$NC"
printf "  키:   %s\n" "$KEY_FILE"
printf "  인증서: %s\n" "$CRT_FILE"
printf "  생성: %s\n" "$MADE_WITH"
printf "%s===============================================%s\n\n" "$DIM" "$NC"
printf "켜는 방법 — .env 에 추가:\n"
printf "  %sHTTPS_ENABLED=true%s\n\n" "$BLUE" "$NC"
printf "그리고 서버를 다시 시작하세요:\n"
printf "  %snpm run server%s\n\n" "$BLUE" "$NC"
printf "%s인증서 경로를 바꾸려면 .env 의 HTTPS_KEY_PATH / HTTPS_CERT_PATH 를 설정하세요.%s\n\n" "$DIM" "$NC"
