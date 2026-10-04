import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../.github/scripts/win-desktop-package-proof.ps1', import.meta.url));
const compare = fileURLToPath(new URL('../../.github/scripts/compare-desktop-databases.py', import.meta.url));
const source = readFileSync(script, 'utf8');
test('package proof requires draft exact commit, signed exact bytes and build identity before install', () => {
  for (const check of ['meta.isDraft', 'meta.targetCommitish -cne $CandidateCommit', 'build.sha256 -cne $CandidateSha256', '(Sha $exe) -cne $CandidateSha256', "$sig.Status -ne 'Valid'", 'package.signer -cne $liveSignature.SignerCertificate.Subject']) {
    assert.ok(source.includes(check), check);
  }
  assert.match(source, /normal|production updater delivery/u);
  assert.doesNotMatch(source, /normalUpdaterDeliveryProven = \$true|Stop-Process|Invoke-RestMethod/u);
  assert.match(source, /\$env:GH_TOKEN = \$null/u);
  assert.match(source, /candidateClose\.accepted/u);
  assert.match(source, /liveClose\.accepted/u);
});

test('real read-only SQLite comparison detects lost duplicates, schema changes, metadata loss and permits appended rows', () => {
  const py = String.raw`
import importlib.util, sqlite3, tempfile
from contextlib import closing
from pathlib import Path
spec = importlib.util.spec_from_file_location('compare', ${JSON.stringify(compare)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as folder:
    a,b = Path(folder)/'a.db', Path(folder)/'b.db'
    for path in (a,b):
        with closing(sqlite3.connect(path)) as c, c:
            c.executescript('CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(22); CREATE TABLE app_meta(key TEXT,value TEXT); CREATE TABLE project(data BLOB);')
            c.execute('INSERT INTO app_meta VALUES(?,?)', ('last_version', '0.1.9+1467' if path == b else '0.1.9+1450'))
            c.execute('INSERT INTO app_meta VALUES(?,?)', ('first_run_at', '2026-10-04'))
            c.executemany('INSERT INTO project VALUES(?)', [(b'secret',),(b'secret',)])
    assert m.compare(a,b,'0.1.9+1467',22)['differences'] == []
    with closing(sqlite3.connect(b)) as c, c: c.execute('INSERT INTO project VALUES(?)',(b'new',))
    assert m.compare(a,b,'0.1.9+1467',22)['differences'] == []
    with closing(sqlite3.connect(b)) as c, c: c.execute('DELETE FROM project WHERE rowid=1')
    result=m.compare(a,b,'0.1.9+1467',22)
    assert result['differences'] == ['project: 1 live rows missing or changed'], result
    assert 'secret' not in str(result)
    assert 'unchanged expected schema' in str(m.compare(a,b,'0.1.9+1467',23))
    with closing(sqlite3.connect(b)) as c, c: c.execute("UPDATE app_meta SET value='changed' WHERE key='first_run_at'")
    assert 'app_meta changed non-launch metadata' in m.compare(a,b,'0.1.9+1467',22)['differences']
    with closing(sqlite3.connect(b)) as c, c: c.execute('DELETE FROM app_meta')
    assert 'app_meta lost keys' in m.compare(a,b,'0.1.9+1467',22)['differences']
print('PASS')
`;
  const result = spawnSync('python', ['-I', '-B', '-c', py], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/u);
});

test('PowerShell helper parses without executing any QA action', {skip: process.platform !== 'win32'}, () => {
  const command = "$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }";
  const quoted = script.replaceAll("'", "''");
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command.replace('$args[0]', `'${quoted}'`)], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
});
