import { readFile } from 'node:fs/promises';

export type MonitorProcess = {
    kind: 'client' | 'task' | 'pathfinder';
    bot: string | null;
    pid: number;
    startedAt: string;
};

export type MonitorReading = MonitorProcess & { rssBytes: number | null; cpuPercent: number | null };
export type MonitorSample = { at: number; processes: MonitorReading[] };
export type MonitorSnapshot = {
    sampledAt: number | null;
    sampleIntervalMs: number;
    processes: MonitorReading[];
    history: MonitorSample[];
    downsampled: boolean;
};

type ProcStat = { startTicks: number; cpuTicks: number; rssPages: number };
type ProcUnits = { clockTicks: number; pageBytes: number; bootAt: number | null };
type ProcessBaseline = { startTicks: number; cpuTicks: number | null; monotonicAt: number };

const SAMPLE_INTERVAL_MS = 500;
const RETENTION_MS = 60 * 60 * 1000;
const MAX_SAMPLES = RETENTION_MS / SAMPLE_INTERVAL_MS + 1;
const MAX_HISTORY_POINTS = 240;

export function parseProcStat(line: string): ProcStat | null {
    // Linux allows spaces and parentheses in comm. The fields after the last
    // closing parenthesis start at field 3 (state), followed by numeric fields.
    const end = line.lastIndexOf(')');
    if (end < 0) return null;
    const fields = line.slice(end + 1).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    const startTicks = Number(fields[19]);
    const rssPages = Number(fields[21]);
    if (![userTicks, systemTicks, startTicks, rssPages].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    return { startTicks, cpuTicks: userTicks + systemTicks, rssPages };
}

async function procUnits(): Promise<ProcUnits | null> {
    if (process.platform !== 'linux') return null;
    try {
        const result = Bun.spawnSync(['getconf', '-a'], { stderr: 'ignore' });
        if (!result.success) return null;
        const text = result.stdout.toString();
        const clockTicks = Number(/^CLK_TCK\s+(\d+)$/m.exec(text)?.[1]);
        const pageBytes = Number(/^(?:PAGESIZE|PAGE_SIZE)\s+(\d+)$/m.exec(text)?.[1]);
        if (!(clockTicks > 0 && pageBytes > 0)) return null;
        const stat = await readFile('/proc/stat', 'utf8').catch(() => '');
        const bootSeconds = Number(/^btime (\d+)$/m.exec(stat)?.[1]);
        return { clockTicks, pageBytes, bootAt: bootSeconds > 0 ? bootSeconds * 1000 : null };
    } catch {
        return null;
    }
}

async function processStat(pid: number): Promise<ProcStat | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        return parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
    } catch {
        return null;
    }
}

export function downsampleMonitorHistory(history: MonitorSample[]): MonitorSample[] {
    if (history.length <= MAX_HISTORY_POINTS) return history;
    const selected = new Set([0, history.length - 1]);
    const peaks = new Map<string, { rss: number; rssAt: number; cpu: number; cpuAt: number }>();
    const totals: { rss: number; cpu: number }[] = [];

    for (const [index, sample] of history.entries()) {
        let rss = 0;
        let cpu = 0;
        for (const reading of sample.processes) {
            const key = `${reading.kind}:${reading.bot ?? ''}`;
            const peak = peaks.get(key) ?? { rss: -1, rssAt: index, cpu: -1, cpuAt: index };
            if (reading.rssBytes != null) {
                rss += reading.rssBytes;
                if (reading.rssBytes > peak.rss) {
                    peak.rss = reading.rssBytes;
                    peak.rssAt = index;
                }
            }
            if (reading.cpuPercent != null) {
                cpu += reading.cpuPercent;
                if (reading.cpuPercent > peak.cpu) {
                    peak.cpu = reading.cpuPercent;
                    peak.cpuAt = index;
                }
            }
            peaks.set(key, peak);
        }
        totals.push({ rss, cpu });
    }

    // Save each process's highest visible readings and leave at least half
    // the budget for peaks across successive intervals.
    for (const peak of peaks.values()) {
        if (selected.size >= MAX_HISTORY_POINTS / 2) break;
        if (peak.rss >= 0) selected.add(peak.rssAt);
        if (peak.cpu >= 0) selected.add(peak.cpuAt);
    }
    const buckets = Math.floor((MAX_HISTORY_POINTS - selected.size) / 2);
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor(bucket * history.length / buckets);
        const end = Math.floor((bucket + 1) * history.length / buckets);
        let rssAt = start;
        let cpuAt = start;
        for (let index = start + 1; index < end; index++) {
            if (totals[index]!.rss > totals[rssAt]!.rss) rssAt = index;
            if (totals[index]!.cpu > totals[cpuAt]!.cpu) cpuAt = index;
        }
        selected.add(rssAt);
        selected.add(cpuAt);
    }
    return [...selected].sort((a, b) => a - b).map(index => history[index]!);
}

export function createDashboardMonitor(getProcesses: () => MonitorProcess[]) {
    let unitsPromise: Promise<ProcUnits | null> | undefined;
    let running = false;
    let sampling = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Map<string, ProcessBaseline>();
    const samples: MonitorSample[] = [];

    async function sample() {
        const thisGeneration = generation;
        const at = Date.now();
        const monotonicAt = performance.now();
        const next = new Map<string, ProcessBaseline>();
        sampling = true;
        try {
            const units = await (unitsPromise ??= procUnits());
            const children = getProcesses();
            const processes = await Promise.all(children.map(async (child): Promise<MonitorReading> => {
                const unavailable = { ...child, rssBytes: null, cpuPercent: null };
                if (!units) return unavailable;
                const key = JSON.stringify([child.kind, child.bot, child.pid, child.startedAt]);
                const baseline = previous.get(key);
                const stat = await processStat(child.pid);
                if (baseline && (!stat || baseline.startTicks !== stat.startTicks)) {
                    // Keep the original birth identity across disappearance or
                    // PID reuse, but restart CPU measurement after missing data.
                    next.set(key, { ...baseline, cpuTicks: null, monotonicAt });
                    return unavailable;
                }
                if (!stat) return unavailable;
                if (!baseline && units.bootAt !== null) {
                    const bornAt = units.bootAt + stat.startTicks * 1000 / units.clockTicks;
                    // btime is expressed in whole seconds; allow clock rounding
                    // and the short interval between spawn and recording it.
                    if (Math.abs(Date.parse(child.startedAt) - bornAt) > 3000) return unavailable;
                }
                const elapsed = baseline ? monotonicAt - baseline.monotonicAt : 0;
                const delta = baseline?.cpuTicks == null ? -1 : stat.cpuTicks - baseline.cpuTicks;
                next.set(key, { startTicks: stat.startTicks, cpuTicks: stat.cpuTicks, monotonicAt });
                return {
                    ...child,
                    rssBytes: stat.rssPages * units.pageBytes,
                    cpuPercent: elapsed > 0 && delta >= 0 ? delta * 100_000 / (units.clockTicks * elapsed) : null,
                };
            }));
            if (!running || thisGeneration !== generation) return;
            previous = next;
            samples.push({ at, processes });
            while (samples.length > MAX_SAMPLES || (samples[0] && samples[0].at < at - RETENTION_MS)) samples.shift();
        } catch (error) {
            console.error('[fleet-monitor] Could not sample resources.', error);
        } finally {
            sampling = false;
            if (running) {
                timer = setTimeout(() => void sample(), Math.max(0, SAMPLE_INTERVAL_MS - (performance.now() - monotonicAt)));
                timer.unref();
            }
        }
    }

    function start() {
        if (running) return;
        running = true;
        if (!sampling) void sample();
    }

    function stop() {
        running = false;
        generation++;
        clearTimeout(timer);
        previous = new Map();
    }

    function read(windowSeconds = 60): MonitorSnapshot {
        const latest = samples.at(-1);
        const windowMs = Number.isFinite(windowSeconds) ? Math.min(RETENTION_MS, windowSeconds * 1000) : 60_000;
        const cutoff = Date.now() - windowMs;
        const history = windowMs > 0 ? samples.filter(point => point.at >= cutoff) : [];
        return {
            sampledAt: latest?.at ?? null,
            sampleIntervalMs: SAMPLE_INTERVAL_MS,
            processes: latest?.processes ?? [],
            history: downsampleMonitorHistory(history),
            downsampled: history.length > MAX_HISTORY_POINTS,
        };
    }

    return { start, stop, read };
}
