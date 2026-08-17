import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const hiperPath = new URL('../../agent/ExpedAgent/HiperRepository.cs', import.meta.url);
const programPath = new URL('../../agent/ExpedAgent/Program.cs', import.meta.url);
const infoPath = new URL('../../agent/ExpedAgent/AgentInfo.cs', import.meta.url);

describe('Agent readiness Hiper 197', () => {
  it('faz probe real read-only e publica conexão/query/schema separadamente', async () => {
    const [hiper, program, info] = await Promise.all([
      readFile(hiperPath, 'utf8'),
      readFile(programPath, 'utf8'),
      readFile(infoPath, 'utf8'),
    ]);

    expect(info).toMatch(/HiperSchemaTarget\s*=\s*"Hiper Loja 197"/);
    expect(hiper).toMatch(/ProbeReadinessAsync/);
    expect(hiper).toMatch(/SELECT\s+TOP\s*\(1\)[\s\S]*FROM\s+pedido_venda/i);
    expect(hiper).toMatch(/INFORMATION_SCHEMA\.COLUMNS/i);
    expect(hiper).not.toMatch(/ProbeReadinessAsync[\s\S]{0,5000}\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i);

    expect(program).toMatch(/health\.json/);
    expect(program).toMatch(/AgentReadinessService/);
    expect(program).toMatch(/connected[\s\S]*queryOk[\s\S]*schemaCompatible/i);
  });

  it('não atribui causalidade à atualização 195→197', async () => {
    const info = await readFile(infoPath, 'utf8');
    expect(info).toMatch(/195.*197|197.*195/);
    expect(info).toMatch(/contexto|nao.*causa|sem evid[eê]ncia/i);
  });
});
