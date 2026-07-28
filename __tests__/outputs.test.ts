import { ValidationResult } from '../src/checks';
import { toActionOutputs } from '../src/outputs';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [],
  sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
};

describe('toActionOutputs', () => {
  it('serializes validation outputs for GitHub Actions', () => {
    const outputs = toActionOutputs(result);
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
    });
    expect(outputs).toHaveProperty('readiness_badge_markdown');
    expect(outputs).toHaveProperty('readiness_badge_url');
    expect(outputs).toHaveProperty('num_sponsoring');
    expect(outputs).toHaveProperty('num_sponsored');
  });

  it('includes a comment URL when provided', () => {
    const outputs = toActionOutputs(result, 'https://github.com/comment');
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
    });
    expect(outputs).toHaveProperty('readiness_badge_markdown');
    expect(outputs).toHaveProperty('readiness_badge_url');
    expect(outputs).toHaveProperty('num_sponsoring');
    expect(outputs).toHaveProperty('num_sponsored');
  });

  it('generates pass badge for valid results', () => {
    const outputs = toActionOutputs(result);
    expect(outputs.readiness_badge_url).toContain('brightgreen');
    expect(outputs.readiness_badge_url).toContain('Ready');
    expect(outputs.readiness_badge_markdown).toContain('brightgreen');
  });

  it('generates fail badge for invalid results', () => {
    const failResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
    };
    const outputs = toActionOutputs(failResult);
    expect(outputs.readiness_badge_url).toContain('red');
    expect(outputs.readiness_badge_url).toContain('Not%20Ready');
    expect(outputs.readiness_badge_markdown).toContain('red');
  });

  it('badge outputs contain no PII', () => {
    const outputs = toActionOutputs(result);
    const combined = outputs.readiness_badge_markdown + outputs.readiness_badge_url;
    expect(combined).not.toContain('5.0000000');
    expect(combined).not.toContain('USDC');
    expect(combined).not.toContain('github.com/account');
  });

  it('includes sponsor counts in outputs', () => {
    const sponsoredResult: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      checks: [],
      sponsorshipInfo: { numSponsoring: 2, numSponsored: 1 },
    };
    const outputs = toActionOutputs(sponsoredResult);
    expect(outputs.num_sponsoring).toBe('2');
    expect(outputs.num_sponsored).toBe('1');
  });
});
