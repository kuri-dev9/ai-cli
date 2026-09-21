// Configure network defaults before other imports execute.
import net from 'node:net';

/**
 * 이름으로 연결할 때 Node 가 IPv4 로 넘어가지 못하고 매달리는 것을 막는다.
 *
 * Node 는 호스트명을 받으면 IPv4 와 IPv6 주소를 번갈아 시도한다(Happy Eyeballs).
 * 보통은 둘 중 되는 쪽으로 빠르게 붙지만, IPv6 주소를 **광고만 받고 실제로는
 * 나갈 수 없는** 환경(예: VPN 이 IPv6 경로를 추가해 두었지만 인터넷 IPv6 는
 * 닿지 않는 경우)에서는 그 전환이 일어나지 않고 연결이 타임아웃까지 멈춰 있다.
 *
 * 증상이 고약하다 — `curl` 은 같은 주소로 잘 나가고(폴백을 제대로 한다), IP 를
 * 직접 주면 Node 도 잘 붙는다. 오직 "이름으로 연결할 때"만 실패해서, 네트워크가
 * 막혔다거나 DNS 가 이상하다는 쪽으로 오래 헤매게 된다. 실제로 텔레그램 브리지가
 * `fetch failed`(ETIMEDOUT) 하나만 남기고 죽는 형태로 나타났다.
 *
 * `dns.setDefaultResultOrder('ipv4first')` 로는 고쳐지지 않는다. 그것은 주소를
 * 주는 순서만 바꿀 뿐, 자동 선택 로직 자체는 그대로 돌기 때문이다.
 *
 * IPv6 로만 닿는 대상을 쓰게 되면 이 설정을 되돌려야 한다. 지금 이 서버가
 * 이야기하는 상대(텔레그램, 프로바이더 API)는 모두 IPv4 를 제공한다.
 */
net.setDefaultAutoSelectFamily(false);
