import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PRODUCT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_INPUT_DIR = path.join(PRODUCT_ROOT, 'artifacts');
const OS_ORDER = ['darwin', 'linux', 'win32'];
const DEFAULT_EXPECTED_E2E = 4;
const hostPlatform = () => {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
};
const ARCHES = new Set(['arm64', 'x64']);
const BUILD_TARGETS = new Set(['dmg+zip', 'nsis', 'appimage']);
const FINDING_SEVERITIES = new Set(['info', 'warning', 'error']);
// D4 names the workflow owners; the product-UI owner is the explicit follow-up
// lane required by the Slice 4 binding for the missing document editor surface.
const FINDING_OWNERS = new Set(['D5', 'P5.D1', 'P5.D2', 'follow-up product UI lane']);
const MANDATORY_FINDINGS = [
  {
    id: 'document-project-editor-flow-not-e2e-covered',
    severity: 'warning',
    message: 'Document-project editor flow is not E2E-covered: the document UI surface is absent from the Electron edition (App.tsx mounts upload/config/processing/review/export only; document engine main-side).',
    owner: 'follow-up product UI lane',
  },
];
const MANDATORY_FINDING_IDS = new Set(MANDATORY_FINDINGS.map((finding) => finding.id));
const GENERATED_FINDING_PREFIX = 'generator-';

function usage() {
  return [
    'Usage: node scripts/generate-qualification-report.mjs [options]',
    '',
    `  --input-dir <path>  Qualification/E2E artifact directory (default: ${DEFAULT_INPUT_DIR})`,
    `  --os <list>         Comma-separated OS list (default: ${hostPlatform()})`,
    `  --expected-e2e <count> Expected E2E scenario count (default: ${DEFAULT_EXPECTED_E2E})`,
    '  --help              Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  let inputDir = DEFAULT_INPUT_DIR;
  let inputDirProvided = false;
  let expectedE2e = DEFAULT_EXPECTED_E2E;
  const osValues = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsIndex = argument.indexOf('=');
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : argument.slice(equalsIndex + 1);

    if (option === '--help' || option === '-h') {
      return { help: true };
    }
    if (option !== '--input-dir' && option !== '--os' && option !== '--expected-e2e') {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = inlineValue === null ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    if (option === '--input-dir') {
      inputDir = path.resolve(value);
      inputDirProvided = true;
    } else if (option === '--expected-e2e') {
      const parsedExpectedE2e = Number(value);
      if (!Number.isInteger(parsedExpectedE2e) || parsedExpectedE2e < 0) {
        throw new Error('--expected-e2e must be a non-negative integer');
      }
      expectedE2e = parsedExpectedE2e;
    } else {
      osValues.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
    }
  }

  const oses = osValues.length > 0 ? osValues : [hostPlatform()];
  const unknownOses = oses.filter((os) => !OS_ORDER.includes(os));
  if (unknownOses.length > 0) {
    throw new Error(`Unsupported OS value(s): ${unknownOses.join(', ')}. Expected ${OS_ORDER.join(', ')}.`);
  }
  const uniqueOses = [...new Set(oses)];
  return { help: false, inputDir, inputDirProvided, oses: uniqueOses, expectedE2e };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateQualificationReport(report, expectedOs, { requireTracePath }) {
  const errors = [];
  if (!isRecord(report)) return ['report must be a JSON object'];

  if (report.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (report.os !== expectedOs) errors.push(`os must be ${expectedOs}`);
  if (typeof report.arch !== 'string' || !ARCHES.has(report.arch)) errors.push('arch must be arm64 or x64');
  if (typeof report.timestamp !== 'string' || !Number.isFinite(Date.parse(report.timestamp))) errors.push('timestamp must be an ISO-8601 date string');
  if (typeof report.gitSha !== 'string') errors.push('gitSha must be a string');
  if (typeof report.buildTarget !== 'string' || !BUILD_TARGETS.has(report.buildTarget)) {
    errors.push('buildTarget must be dmg+zip, nsis, or appimage');
  }

  if (!isRecord(report.installerArtifact)) {
    errors.push('installerArtifact must be an object');
  } else {
    if (typeof report.installerArtifact.exists !== 'boolean') errors.push('installerArtifact.exists must be a boolean');
    if (!isNonNegativeNumber(report.installerArtifact.sizeBytes)) errors.push('installerArtifact.sizeBytes must be a non-negative number');
    if (typeof report.installerArtifact.sha256 !== 'string') errors.push('installerArtifact.sha256 must be a string');
  }

  if (!Array.isArray(report.contentChecks)) {
    errors.push('contentChecks must be an array');
  } else {
    report.contentChecks.forEach((check, index) => {
      if (!isRecord(check)) {
        errors.push(`contentChecks[${index}] must be an object`);
        return;
      }
      if (typeof check.name !== 'string' || check.name.length === 0) errors.push(`contentChecks[${index}].name must be a non-empty string`);
      if (typeof check.passed !== 'boolean') errors.push(`contentChecks[${index}].passed must be a boolean`);
      if (typeof check.detail !== 'string') errors.push(`contentChecks[${index}].detail must be a string`);
    });
  }

  if (!isRecord(report.bootSmoke)) {
    errors.push('bootSmoke must be an object');
  } else {
    if (typeof report.bootSmoke.passed !== 'boolean') errors.push('bootSmoke.passed must be a boolean');
    if (!isNonNegativeNumber(report.bootSmoke.durationMs)) errors.push('bootSmoke.durationMs must be a non-negative number');
    if (typeof report.bootSmoke.detail !== 'string') {
      errors.push('bootSmoke.detail must be a string');
    } else {
      if (report.bootSmoke.detail.length === 0) errors.push('bootSmoke.detail must be a non-empty string');
      if (report.bootSmoke.passed === true && isNonNegativeNumber(report.bootSmoke.durationMs) && report.bootSmoke.durationMs <= 0) {
        errors.push('bootSmoke.durationMs must be greater than 0 when bootSmoke.passed is true');
      }
    }
  }

  if (!Array.isArray(report.e2eScenarios)) {
    errors.push('e2eScenarios must be an array');
  } else {
    report.e2eScenarios.forEach((scenario, index) => {
      if (!isRecord(scenario)) {
        errors.push(`e2eScenarios[${index}] must be an object`);
        return;
      }
      if (typeof scenario.name !== 'string' || scenario.name.length === 0) errors.push(`e2eScenarios[${index}].name must be a non-empty string`);
      if (typeof scenario.passed !== 'boolean') errors.push(`e2eScenarios[${index}].passed must be a boolean`);
      if (!isNonNegativeNumber(scenario.durationMs)) errors.push(`e2eScenarios[${index}].durationMs must be a non-negative number`);
      if (requireTracePath && typeof scenario.tracePath !== 'string') errors.push(`e2eScenarios[${index}].tracePath must be a string`);
      if (!requireTracePath && scenario.tracePath !== undefined && typeof scenario.tracePath !== 'string') errors.push(`e2eScenarios[${index}].tracePath must be a string when present`);
    });
  }

  if (!Array.isArray(report.findings)) {
    errors.push('findings must be an array');
  } else {
    const findingIds = new Set();
    report.findings.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      if (typeof item.id !== 'string' || item.id.length === 0) {
        errors.push(`findings[${index}].id must be a non-empty string`);
      } else if (findingIds.has(item.id)) {
        errors.push(`findings[${index}].id must be unique (duplicate: ${item.id})`);
      } else {
        findingIds.add(item.id);
      }
      if (typeof item.severity !== 'string' || !FINDING_SEVERITIES.has(item.severity)) errors.push(`findings[${index}].severity must be info, warning, or error`);
      if (typeof item.message !== 'string' || item.message.length === 0) errors.push(`findings[${index}].message must be a non-empty string`);
      if (typeof item.owner !== 'string' || !FINDING_OWNERS.has(item.owner)) errors.push(`findings[${index}].owner is not a recognized workflow owner`);
    });
  }

  if (!['pass', 'fail', 'partial'].includes(report.overallStatus)) errors.push('overallStatus must be pass, fail, or partial');
  return errors;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkE2eSuites(payload) {
  const scenarios = [];
  const errors = [];

  if (!isRecord(payload) || !Array.isArray(payload.suites)) {
    return { scenarios, errors: ['Playwright report must contain a suites array'] };
  }

  const resultEntriesFor = (spec, specLabel) => {
    const results = [];
    if (spec.results !== undefined) {
      if (!Array.isArray(spec.results)) {
        errors.push(`Playwright spec ${specLabel} has a non-array results field`);
      } else {
        results.push(...spec.results.filter(isRecord));
      }
    }
    if (spec.tests !== undefined && !Array.isArray(spec.tests)) {
      errors.push(`Playwright spec ${specLabel} has a non-array tests field`);
      return results;
    }
    for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
      if (!isRecord(test)) {
        errors.push(`Playwright spec ${specLabel} contains an invalid test`);
        continue;
      }
      if (test.results !== undefined && !Array.isArray(test.results)) {
        errors.push(`Playwright test ${specLabel} has a non-array results field`);
        continue;
      }
      if (Array.isArray(test.results)) results.push(...test.results.filter(isRecord));
    }
    return results;
  };

  const tracePathFor = (spec) => {
    const attachments = [];
    if (Array.isArray(spec.attachments)) attachments.push(...spec.attachments);
    for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
      if (!isRecord(test)) continue;
      if (Array.isArray(test.attachments)) attachments.push(...test.attachments);
      if (Array.isArray(test.results)) {
        for (const result of test.results) {
          if (isRecord(result) && Array.isArray(result.attachments)) attachments.push(...result.attachments);
        }
      }
    }
    const trace = attachments.find((attachment) => isRecord(attachment)
      && typeof attachment.path === 'string'
      && (attachment.name === 'trace' || String(attachment.contentType || '').includes('zip')));
    return trace?.path || '';
  };

  const visitSuite = (suite, suiteTitles = []) => {
    if (!isRecord(suite)) {
      errors.push('Playwright suite entry must be an object');
      return;
    }
    const nextTitles = typeof suite.title === 'string' && suite.title.length > 0
      ? [...suiteTitles, suite.title]
      : suiteTitles;
    const suiteLabel = nextTitles.join(' / ') || '<root>';

    if (suite.specs !== undefined && !Array.isArray(suite.specs)) {
      errors.push(`Playwright suite ${suiteLabel} has a non-array specs field`);
    }
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRecord(spec)) {
        errors.push(`Playwright suite ${suiteLabel} contains an invalid spec`);
        continue;
      }
      const specLabel = typeof spec.title === 'string' && spec.title.length > 0
        ? spec.title
        : suiteLabel;
      const results = resultEntriesFor(spec, specLabel);
      const lastResult = results[results.length - 1];
      if (!lastResult) {
        errors.push(`Playwright spec ${specLabel} has no test result`);
        continue;
      }
      scenarios.push({
        name: specLabel,
        passed: lastResult.status === 'passed' || lastResult.status === 'flaky',
        durationMs: isNonNegativeNumber(lastResult.duration) ? lastResult.duration : 0,
        tracePath: tracePathFor(spec),
      });
      if (spec.suites !== undefined && !Array.isArray(spec.suites)) {
        errors.push(`Playwright spec ${specLabel} has a non-array suites field`);
      }
      for (const childSuite of Array.isArray(spec.suites) ? spec.suites : []) visitSuite(childSuite, nextTitles);
    }

    if (suite.suites !== undefined && !Array.isArray(suite.suites)) {
      errors.push(`Playwright suite ${suiteLabel} has a non-array suites field`);
    }
    for (const childSuite of Array.isArray(suite.suites) ? suite.suites : []) visitSuite(childSuite, nextTitles);
  };

  for (const suite of payload.suites) visitSuite(suite);

  if (isRecord(payload.stats)) {
    for (const field of ['unexpected', 'failed']) {
      if (isNonNegativeNumber(payload.stats[field]) && payload.stats[field] > 0) {
        errors.push(`Playwright stats.${field} reports ${payload.stats[field]} failing result(s)`);
      }
    }
  }
  return { scenarios, errors };
}

function finding(id, message, owner = 'D5') {
  return { id, severity: 'error', message, owner };
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'unnamed';
}

function generatedFindingsFor(report, e2eErrors, e2eReportPath, expectedE2e) {
  const failures = [];
  const usedIds = new Set();
  const add = (item) => {
    let id = item.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${item.id}-${suffix++}`;
    usedIds.add(id);
    failures.push({ ...item, id });
  };

  for (const check of report.contentChecks) {
    if (!check.passed) add(finding(`generator-content-check-failed-${slug(check.name)}`, `Content check failed: ${check.name}${check.detail ? ` — ${check.detail}` : ''}.`));
  }
  if (!report.bootSmoke.passed) add(finding('generator-boot-smoke-failed', `Boot smoke failed${report.bootSmoke.detail ? `: ${report.bootSmoke.detail}` : '.'}`));
  for (const scenario of report.e2eScenarios) {
    if (!scenario.passed) add(finding(`generator-e2e-scenario-failed-${slug(scenario.name)}`, `E2E scenario failed: ${scenario.name}.`));
  }
  if (report.e2eScenarios.length !== expectedE2e) {
    add(finding(
      'generator-e2e-scenario-count-mismatch',
      `E2E scenario count mismatch: expected ${expectedE2e}, got ${report.e2eScenarios.length}.`,
    ));
  }
  if (report.installerArtifact.exists !== true || report.installerArtifact.sizeBytes === 0) {
    add(finding('generator-installer-artifact-missing-or-empty', 'Installer artifact is missing or zero-byte.'));
  }
  for (const error of e2eErrors) {
    add(finding('generator-e2e-report-invalid', `E2E report ${e2eReportPath ? `at ${e2eReportPath} ` : ''}is invalid: ${error}.`));
  }
  return failures;
}

function reportStatus(report, generatedFailures) {
  return generatedFailures.length === 0 && !report.findings.some((item) => item.severity === 'error') ? 'pass' : 'fail';
}

function findE2eReport(inputDir, os, inputDirProvided) {
  const expectedPath = path.join(inputDir, `p4d5-e2e-${os}.json`);
  if (fs.existsSync(expectedPath)) return expectedPath;

  // `qualify:release` deliberately keeps the exact binding command shape. Its
  // local Playwright default is test-results/e2e/results.json; CI supplies the
  // fixed p4d5-e2e-{os}.json path. Only use this fallback for the local default
  // directory and the host OS, never as a substitute for another OS artifact.
  if (!inputDirProvided && os === hostPlatform()) {
    const localDefault = path.join(PRODUCT_ROOT, 'test-results', 'e2e', 'results.json');
    if (fs.existsSync(localDefault)) return localDefault;
  }
  return null;
}

function validReportRow(os, report, reportPath) {
  const contentPassed = report.contentChecks.filter((check) => check.passed).length;
  const e2ePassed = report.e2eScenarios.filter((scenario) => scenario.passed).length;
  return {
    os,
    report,
    reportPath,
    status: report.overallStatus,
    contentPassed,
    contentTotal: report.contentChecks.length,
    bootPassed: report.bootSmoke.passed,
    bootDurationMs: report.bootSmoke.durationMs,
    e2ePassed,
    e2eTotal: report.e2eScenarios.length,
    findings: report.findings,
  };
}

function failureRow(os, message, reportPath = null) {
  return {
    os,
    report: null,
    reportPath,
    status: 'fail',
    contentPassed: 0,
    contentTotal: 0,
    bootPassed: false,
    bootDurationMs: 0,
    e2ePassed: 0,
    e2eTotal: 0,
    findings: [
      ...MANDATORY_FINDINGS.map((item) => ({ ...item })),
      finding(`generator-${slug(message)}`, message),
    ],
    error: message,
  };
}

function processOs(os, inputDir, inputDirProvided, expectedE2e) {
  const reportPath = path.join(inputDir, `p4d5-qualification-${os}.json`);
  if (!fs.existsSync(reportPath)) return failureRow(os, `Missing per-OS qualification input for ${os}: ${reportPath}`, reportPath);

  let report;
  try {
    report = readJson(reportPath);
  } catch (error) {
    return failureRow(os, `Unable to read qualification input for ${os}: ${error.message}`, reportPath);
  }

  const inputErrors = validateQualificationReport(report, os, { requireTracePath: false });
  if (inputErrors.length > 0) {
    return failureRow(os, `Invalid qualification schema for ${os}: ${inputErrors.join('; ')}`, reportPath);
  }

  const e2eReportPath = findE2eReport(inputDir, os, inputDirProvided);
  let e2eScenarios = [];
  let e2eErrors = [];
  if (!e2eReportPath) {
    e2eErrors = [`missing Playwright report for ${os}`];
  } else {
    try {
      const e2eReport = readJson(e2eReportPath);
      ({ scenarios: e2eScenarios, errors: e2eErrors } = walkE2eSuites(e2eReport));
    } catch (error) {
      e2eErrors = [`unable to read Playwright report: ${error.message}`];
    }
  }

  report.e2eScenarios = e2eScenarios;
  report.findings = report.findings
    .filter((item) => !MANDATORY_FINDING_IDS.has(item.id) && !String(item.id).startsWith(GENERATED_FINDING_PREFIX))
    .concat(MANDATORY_FINDINGS.map((item) => ({ ...item })));
  const generatedFailures = generatedFindingsFor(report, e2eErrors, e2eReportPath, expectedE2e);
  report.findings.push(...generatedFailures);
  report.overallStatus = reportStatus(report, generatedFailures);

  const outputErrors = validateQualificationReport(report, os, { requireTracePath: true });
  if (outputErrors.length > 0) {
    return failureRow(os, `Generated qualification schema is invalid for ${os}: ${outputErrors.join('; ')}`, reportPath);
  }

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return validReportRow(os, report, reportPath);
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function findingSummary(row) {
  if (row.findings.length === 0) return '0';
  const warnings = row.findings.filter((item) => item.severity === 'warning').length;
  const errors = row.findings.filter((item) => item.severity === 'error').length;
  const labels = [];
  if (warnings > 0) labels.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (errors > 0) labels.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return `${row.findings.length} (${labels.join(', ')})`;
}

function buildSummary(rows) {
  const overallPass = rows.length > 0 && rows.every((row) => row.status === 'pass');
  const lines = [
    '# P4.D5 Release Qualification',
    '',
    '| OS | Content checks | Boot smoke | E2E | Findings | Overall |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const content = row.report
      ? `${row.contentPassed}/${row.contentTotal} passed`
      : 'missing/invalid';
    const boot = row.report
      ? `${row.bootPassed ? 'PASS' : 'FAIL'} (${row.bootDurationMs} ms)`
      : 'not run';
    const e2e = row.report
      ? `${row.e2ePassed}/${row.e2eTotal} passed`
      : 'missing/invalid';
    lines.push(`| ${row.os} | ${content} | ${boot} | ${e2e} | ${findingSummary(row)} | ${row.status.toUpperCase()} |`);
  }

  lines.push('', `**Overall verdict: ${overallPass ? 'PASS' : 'FAIL'}**`, '');
  lines.push('## Findings', '');
  for (const row of rows) {
    lines.push(`### ${row.os}`);
    if (row.findings.length === 0) {
      lines.push('- None', '');
      continue;
    }
    for (const item of row.findings) {
      lines.push(`- **${escapeTable(item.id)}** (${item.severity}, ${escapeTable(item.owner)}): ${escapeTable(item.message)}`);
    }
    lines.push('');
  }
  return { text: `${lines.join('\n').trimEnd()}\n`, overallPass };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  fs.mkdirSync(options.inputDir, { recursive: true });
  const rows = options.oses.map((os) => processOs(os, options.inputDir, options.inputDirProvided, options.expectedE2e));
  const summary = buildSummary(rows);
  const summaryPath = path.join(options.inputDir, 'p4d5-qualification-summary.md');
  fs.writeFileSync(summaryPath, summary.text, 'utf8');

  for (const row of rows) {
    if (row.status !== 'pass') console.error(`FAIL ${row.os}: ${row.error || 'qualification checks failed'}`);
  }
  console.log(`Wrote ${summaryPath}`);
  console.log(`Overall verdict: ${summary.overallPass ? 'PASS' : 'FAIL'}`);
  return summary.overallPass ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`Qualification report generation failed: ${error.message}`);
    process.exitCode = 1;
  });
