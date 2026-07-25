import * as fs from 'fs';
import * as path from 'path';

describe('.github/workflows/ci.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');

  it('exists and contains valid workflow configuration', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('name: CI');
    expect(content).toContain('actions/checkout@v4');
    expect(content).toContain('actions/setup-node@v4');
    expect(content).toContain('npm ci');
    expect(content).toContain('npm run lint');
    expect(content).toContain('npm test');
    expect(content).toContain('npm run build');
    expect(content).toContain('dist/index.js');
  });

  it('includes comment golden snapshots and coverage verification steps', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('Verify comment golden snapshots and test coverage');
  });
});
