"""디펜스 레벨링 스프레드시트 모델 (DESIGN.md §L — 근사 모델, 정본 검증은 엔진 시뮬레이터 D4)

실행: python3 docs/tasks/defense/tools/leveling_model.py [campaign|endless]
- 기준 타워 곡선(§L4)과 기준 봇(Greedy: 빈 슬롯 우선 → 골드당 DPS 최대 업그레이드)으로
  웨이브마다 공급 DPS P를 계산하고, 목표 여유도 M에서 웨이브 압력 Π = P·η / M을 역산한다(§L3).
- 이 스크립트는 오프라인 생성기의 근사다. 실수 연산을 쓰지만 출력(웨이브 데이터)은 정수로 확정해 JSON에 넣는다.
"""
import sys

TPS = 30
TOWER_COST = [70, 120, 200, 340, 580]   # 기준 타워 누적 비용 Lv1~5 (§L4)
TOWER_DPS = [14, 22, 34, 53, 84]        # 기준 타워 유효 DPS Lv1~5
ETA_REF = 0.75                          # 기준 봇 배치 효율
ETA_TOP = 0.95                          # 상위 플레이어 배치 효율(무한 상한 추정)
CYCLE = ['기본', '기본+', '러시', '휴식', '보스']
M_BASE = {'기본': 1.50, '기본+': 1.35, '러시': 1.25, '휴식': 2.00, '보스': 1.15}
INTERVAL = {'기본': 24, '기본+': 21, '러시': 10, '휴식': 30, '보스': 30}   # 스폰 간격(틱)
BOSS_EXPOSURE_SEC = 9.0

def K(n): return 1.0 if n <= 10 else (0.8 if n <= 20 else 0.65)
def spawn_sec(n): return min(36, 12 + 2 * (n - 1))
def clear_bonus(n): return 2 * (10 + n)

def buy(towers, slots, gold):
    while True:
        best = None
        if len(towers) < slots and gold >= TOWER_COST[0]:
            best = (TOWER_DPS[0] / TOWER_COST[0], 'new', None)
        for i, lv in enumerate(towers):
            if lv < 4:
                c = TOWER_COST[lv + 1] - TOWER_COST[lv]
                r = (TOWER_DPS[lv + 1] - TOWER_DPS[lv]) / c
                if gold >= c and (best is None or r > best[0]):
                    best = (r, 'up', i)
        if best is None:
            return gold
        if best[1] == 'new':
            towers.append(0); gold -= TOWER_COST[0]
        else:
            i = best[2]; gold -= TOWER_COST[towers[i] + 1] - TOWER_COST[towers[i]]; towers[i] += 1

def campaign_stage(waves, slots, g0, X, gold_per_ehp=0.11):
    towers, gold, rows = [], g0, []
    for n in range(1, waves + 1):
        role = '보스' if n == waves else CYCLE[(n - 1) % 5]
        gold = buy(towers, slots, gold)
        P = sum(TOWER_DPS[l] for l in towers)
        M = 1 + (M_BASE[role] - 1) * X
        pressure = P * ETA_REF / M
        D, iv = spawn_sec(n), INTERVAL[role]
        if role == '보스':
            boss = P * BOSS_EXPOSURE_SEC * ETA_REF / M
            H = boss + pressure * D * 0.5 * 0.6
            unit, cnt = round(boss), 1 + int(D * 0.5 * TPS / iv)
        else:
            H = pressure * D; unit, cnt = round(pressure * iv / TPS), int(D * TPS / iv)
        inc = round(H * gold_per_ehp * K(n)) + clear_bonus(n)
        rows.append((n, role, len(towers), sum(towers) + len(towers), P, round(M, 2), round(pressure), unit, cnt, round(H), inc))
        gold += inc
    return rows

# 스테이지: (이름, 웨이브, 슬롯, 시작 골드, 여유 배율 X) — §L2
STAGES = [('S1', 6, 8, 220, 1.6), ('S2', 8, 9, 260, 1.45), ('S3', 8, 10, 300, 1.3), ('S4', 8, 10, 340, 1.35),
          ('S5', 10, 11, 380, 1.1), ('S6', 10, 12, 420, 1.15), ('S7', 10, 12, 460, 1.0), ('S8', 12, 13, 500, 0.85)]

def endless(slots=14, g0=400, designed=30, gold_per_ehp=0.045):
    def X(n): return 1.6 - 0.7 * (n - 1) / (designed - 1)
    def step(i): return 20 if i <= 20 else (50 if i <= 40 else (150 if i <= 60 else 350))
    saw = {'기본': 1000, '기본+': 1080, '러시': 1150, '휴식': 800, '보스': 1250}
    towers, gold, acc, t, rows, p_last = [], g0, 1000, 0.0, [], None
    p_top = slots * TOWER_DPS[4] * ETA_TOP
    for n in range(1, 200):
        role = CYCLE[(n - 1) % 5]
        gold = buy(towers, slots, gold)
        P = sum(TOWER_DPS[l] for l in towers)
        if n <= designed:
            pressure = P * ETA_REF / (1 + (M_BASE[role] - 1) * X(n))
            if n == designed: p_last = pressure
        else:
            acc += step(n - designed); pressure = p_last * acc / 1000 * saw[role] / 1000
        D = spawn_sec(n)
        t += 12 * (0.4 if n > 5 else 1) + (D + 25) / (3 if n > 5 else 1)
        rows.append((n, role, len(towers), sum(towers) + len(towers), P, round(pressure), round(P * ETA_REF / pressure, 2), round(p_top / pressure, 2), round(t / 60, 1)))
        gold += round(pressure * D * gold_per_ehp * (K(n) if n <= designed else 0.3)) + clear_bonus(n)
        if p_top / pressure < 0.85: break
    return rows

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'campaign'
    if mode == 'campaign':
        for name, w, s, g, x in STAGES:
            print(f'== {name} 웨이브 {w} · 슬롯 {s} · 시작 골드 {g} · X {x}')
            print('n 역할 타워수 레벨합 공급DPS 목표M 압력(EHP/s) 단위EHP 마리 총EHP 수입')
            for r in campaign_stage(w, s, g, x): print(*r)
    else:
        print('n 역할 타워수 레벨합 기준봇DPS 압력 기준봇M 상위상한M 누적분(숙련·3×)')
        for r in endless(): print(*r)
