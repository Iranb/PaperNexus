import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildResearchQualityView } from '../src/core/graph/research-quality.js';

export async function auditResearchQuality({ input, output }) {
  if (!input || !output) throw new Error('Required: --input <graph.lite.json> --output <new-directory>');
  const bytes = await fs.readFile(input, 'utf8');
  const { graph, report } = buildResearchQualityView(JSON.parse(bytes));
  // Refuse to overwrite any existing output or corpus directory.
  await fs.mkdir(output, { recursive: false });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'research-graph.json'), JSON.stringify(graph.toJSON()) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--input') || !args.includes('--output')) throw new Error('Required: --input <graph.lite.json> --output <new-directory>');
  const report = await auditResearchQuality({ input: value('--input'), output: value('--output') });
  console.log(JSON.stringify({ rawPapers: report.rawPaperCount, researchPapers: report.paperCount, quarantined: report.quarantinedPapers.length, mergedGroups: report.mergedPapers.length, limitationsReviewed: report.reviewedLimitations.length }, null, 2));
}
