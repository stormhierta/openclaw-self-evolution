/**
 * Metrics Reporter - Human-readable evolution metrics summary
 * 
 * Phase 7B: Produces metrics for PR descriptions and CLI output
 */

import type { EvolutionConfig, EvolutionMetrics, EvolutionRun } from '../types.js';

/** Extracts and formats metrics from evolution runs */
export class MetricsReporter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: EvolutionConfig) {}

  /**
   * Extract metrics from an EvolutionRun result
   */
  extractMetrics(run: EvolutionRun, baselineFitnessScore?: number): EvolutionMetrics {
    const baseline = baselineFitnessScore ?? 0;
    const bestFitness = run.progress?.bestFitnessScore ?? run.bestVariant?.fitnessScore?.overall ?? 0;
    const improvement = bestFitness - baseline;

    // Compute duration
    let durationMs = 0;
    if (run.startedAt) {
      const start = run.startedAt instanceof Date ? run.startedAt : new Date(run.startedAt);
      const inProgress = run.status === 'running' || run.status === 'pending' || run.status === 'paused';
      const end = run.completedAt
        ? (run.completedAt instanceof Date ? run.completedAt : new Date(run.completedAt))
        : (inProgress ? new Date() : start);
      durationMs = end.getTime() - start.getTime();
    }

    // Determine if stopped early
    const stoppedEarly =
      run.status === 'cancelled' ||
      run.status === 'failed' ||
      (run.status === 'completed' && run.currentGeneration < run.maxGenerations);
    const stopReason = run.errorMessage ?? (run.status === 'cancelled' ? 'cancelled' : undefined);

    // Calculate improvement percentage
    let improvementPercent: string;
    if (baseline === 0) {
      improvementPercent = 'N/A';
    } else {
      const pct = (improvement / baseline) * 100;
      improvementPercent = pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
    }

    return {
      skillName: run.skillName,
      runId: run.id,
      status: run.status,
      generationsCompleted: run.progress?.currentGeneration ?? run.currentGeneration,
      maxGenerations: run.maxGenerations,
      totalVariantsEvaluated: run.progress?.variantsEvaluated ?? 0,
      bestFitnessScore: bestFitness,
      baselineFitnessScore: baseline,
      improvement,
      improvementPercent,
      durationMs,
      stoppedEarly,
      stopReason,
    };
  }

  /**
   * Format metrics as markdown (for PR descriptions)
   */
  formatMarkdown(metrics: EvolutionMetrics): string {
    const { skillName, status, generationsCompleted, maxGenerations, bestFitnessScore,
            improvementPercent, durationMs, totalVariantsEvaluated, stoppedEarly, stopReason } = metrics;

    const duration = this.formatDuration(durationMs);
    const improvement = improvementPercent === 'N/A'
      ? `${bestFitnessScore} (no baseline)`
      : `${improvementPercent} vs baseline`;

    const stopNote = this.buildStopNote(stoppedEarly, stopReason);
    const title = `## Evolution Results: \`${skillName}\``;
    const table = [
      '| Metric | Value |',
      '|--------|-------|',
      `| Status | ${status} |`,
      `| Generations | ${generationsCompleted} / ${maxGenerations} |`,
      `| Best Fitness | ${bestFitnessScore} / 100 |`,
      `| Improvement | ${improvement} |`,
      `| Duration | ${duration} |`,
      `| Variants Evaluated | ${totalVariantsEvaluated} |`,
    ].join('\n');

    return title + '\n' + table + stopNote;
  }

  /**
   * Format metrics as plain text (for CLI output)
   */
  formatPlainText(metrics: EvolutionMetrics): string {
    const { skillName, status, generationsCompleted, maxGenerations, bestFitnessScore,
            improvementPercent, durationMs, totalVariantsEvaluated, stoppedEarly, stopReason } = metrics;

    const duration = this.formatDuration(durationMs);
    const improvement = improvementPercent === 'N/A'
      ? `${bestFitnessScore} (no baseline)`
      : `${improvementPercent} vs baseline`;

    const lines: string[] = [
      `Evolution Results: ${skillName}`,
      `  Status:             ${status}`,
      `  Generations:        ${generationsCompleted} / ${maxGenerations}`,
      `  Best Fitness:       ${bestFitnessScore} / 100`,
      `  Improvement:        ${improvement}`,
      `  Duration:           ${duration}`,
      `  Variants Evaluated: ${totalVariantsEvaluated}`,
    ];

    if (stoppedEarly && stopReason) {
      lines.push(`  Stopped early:      ${stopReason}`);
    } else if (stoppedEarly) {
      lines.push(`  Stopped early:      yes`);
    }

    return lines.join('\n');
  }

  /**
   * Build stop note for markdown output
   */
  private buildStopNote(stoppedEarly: boolean, stopReason?: string): string {
    if (stoppedEarly && stopReason) {
      return '\n**Stopped early:** ' + stopReason;
    }
    if (stoppedEarly) {
      return '\n**Stopped early**';
    }
    return '';
  }

  /**
   * Format duration in human-readable form (e.g. "2m 34s")
   */
  formatDuration(ms: number): string {
    if (ms < 0) return '0s';
    if (ms < 1000) return '0s';

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
  }
}