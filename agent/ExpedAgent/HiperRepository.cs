using Microsoft.Data.SqlClient;
using System.Text.Json.Serialization;
namespace ExpedAgent;

public sealed record HiperReadiness(
    [property: JsonPropertyName("connected")] bool Connected,
    [property: JsonPropertyName("queryOk")] bool QueryOk,
    [property: JsonPropertyName("schemaCompatible")] bool SchemaCompatible,
    [property: JsonPropertyName("targetSchema")] string TargetSchema,
    [property: JsonPropertyName("database")] string? Database,
    [property: JsonPropertyName("serverVersion")] string? ServerVersion,
    [property: JsonPropertyName("sampleOrderId")] int? SampleOrderId,
    [property: JsonPropertyName("missingColumns")] IReadOnlyList<string> MissingColumns,
    [property: JsonPropertyName("error")] string? Error);

public sealed record AgentReadinessSnapshot(
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("agentVersion")] string AgentVersion,
    [property: JsonPropertyName("checkedAt")] string CheckedAt,
    [property: JsonPropertyName("hiper")] HiperReadiness Hiper)
{
    public static AgentReadinessSnapshot Create(
        int processId,
        string agentVersion,
        HiperReadiness hiper) =>
        new(processId, agentVersion, DateTimeOffset.UtcNow.ToString("O"), hiper);
}

// ⚠️ Nomes de coluna do cliente (numero_endereco, fone_primario_*, etc.) vieram do
// mapeamento; confirmar 1x no SQL Server real e ajustar se divergir (o log mostra o erro).
public sealed class HiperRepository(string connectionString)
{
    private readonly string _cs = connectionString;

    public static readonly IReadOnlyList<(string Table, string Column)> Hiper197RequiredColumns =
    [
        ("pedido_venda", "id_pedido_venda"), ("pedido_venda", "codigo"),
        ("pedido_venda", "situacao"), ("pedido_venda", "data_hora_geracao"),
        ("pedido_venda", "id_entidade_cliente"), ("pedido_venda", "id_usuario_vendedor"),
        ("pedido_venda", "data_previsao_entrega_final"),
        ("pedido_venda", "data_previsao_entrega_inicial"), ("pedido_venda", "observacao"),
        ("pedido_venda", "valor_frete"), ("pedido_venda", "excluido"),
        ("entidade", "nome"), ("entidade", "logradouro"),
        ("entidade", "numero_endereco"), ("entidade", "complemento"),
        ("entidade", "bairro"), ("entidade", "cep"),
        ("entidade", "fone_primario_ddd"), ("entidade", "fone_primario_numero"),
        ("entidade", "id_cidade"), ("pessoa_fisica", "cpf"),
        ("pessoa_juridica", "cnpj"), ("cidade", "nome"), ("cidade", "uf"),
        ("cidade", "id_cidade"), ("item_pedido_venda", "sequencia_item"),
        ("item_pedido_venda", "id_produto"), ("item_pedido_venda", "valor_unitario"),
        ("item_pedido_venda", "valor_unitario_com_desconto"),
        ("item_pedido_venda", "excluido"), ("item_pedido_venda", "cancelado"),
        ("grade_pedido_venda", "quantidade"), ("grade_pedido_venda", "sequencia_item"),
        ("grade_pedido_venda", "id_pedido_venda"), ("produto", "codigo"),
        ("produto", "nome"), ("produto", "id_produto"),
    ];

    public const string Hiper197ReadOnlyProbeSql = @"
SELECT TOP (1)
       pv.id_pedido_venda,
       pv.codigo,
       pv.situacao,
       pv.data_hora_geracao,
       pv.id_entidade_cliente,
       pv.id_usuario_vendedor,
       pv.excluido
FROM pedido_venda pv WITH (NOLOCK)
ORDER BY pv.id_pedido_venda DESC;";

    public static List<string> GetMissingHiper197Columns(
        IEnumerable<(string Table, string Column)> existing)
    {
        var found = new HashSet<string>(
            existing.Select(item => $"{item.Table}.{item.Column}"),
            StringComparer.OrdinalIgnoreCase);
        return Hiper197RequiredColumns
            .Where(item => !found.Contains($"{item.Table}.{item.Column}"))
            .Select(item => $"{item.Table}.{item.Column}")
            .ToList();
    }

    private static async Task<HashSet<(string Table, string Column)>> ReadSchemaColumnsAsync(
        SqlConnection connection,
        CancellationToken ct)
    {
        var tables = Hiper197RequiredColumns.Select(item => item.Table).Distinct().ToArray();
        var names = tables.Select((_, i) => "@t" + i).ToArray();
        var sql = $"select TABLE_NAME, COLUMN_NAME from INFORMATION_SCHEMA.COLUMNS " +
                  $"where TABLE_NAME in ({string.Join(",", names)})";
        var found = new HashSet<(string Table, string Column)>(
            EqualityComparer<(string Table, string Column)>.Default);
        await using var command = new SqlCommand(sql, connection) { CommandTimeout = 10 };
        for (var i = 0; i < tables.Length; i++) command.Parameters.AddWithValue(names[i], tables[i]);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) found.Add((reader.GetString(0), reader.GetString(1)));
        return found;
    }

    /// <summary>
    /// Readiness do Hiper Loja 197. Abre a mesma Trusted_Connection do Agent,
    /// confere as colunas consumidas e executa uma consulta real somente leitura.
    /// Conexao, query e compatibilidade permanecem sinais independentes.
    /// </summary>
    public async Task<HiperReadiness> ProbeReadinessAsync(CancellationToken ct)
    {
        await using var connection = new SqlConnection(_cs);
        try
        {
            await connection.OpenAsync(ct);
        }
        catch (Exception ex)
        {
            return new(false, false, false, AgentInfo.HiperSchemaTarget, null, null, null, [], ex.Message);
        }

        string? database = null;
        string? serverVersion = null;
        IReadOnlyList<string> missing = [];
        try
        {
            await using (var metadata = new SqlCommand(
                "select DB_NAME(), convert(nvarchar(128), SERVERPROPERTY('ProductVersion'))",
                connection) { CommandTimeout = 10 })
            await using (var reader = await metadata.ExecuteReaderAsync(ct))
            {
                if (await reader.ReadAsync(ct))
                {
                    database = reader.IsDBNull(0) ? null : reader.GetString(0);
                    serverVersion = reader.IsDBNull(1) ? null : reader.GetString(1);
                }
            }

            var existing = await ReadSchemaColumnsAsync(connection, ct);
            missing = GetMissingHiper197Columns(existing);

            int? sampleOrderId = null;
            await using (var probe = new SqlCommand(Hiper197ReadOnlyProbeSql, connection) { CommandTimeout = 10 })
            await using (var reader = await probe.ExecuteReaderAsync(ct))
            {
                if (await reader.ReadAsync(ct) && !reader.IsDBNull(0)) sampleOrderId = reader.GetInt32(0);
            }

            var compatible = missing.Count == 0;
            return new(
                true,
                true,
                compatible,
                AgentInfo.HiperSchemaTarget,
                database,
                serverVersion,
                sampleOrderId,
                missing,
                compatible ? null : $"Colunas ausentes: {string.Join(", ", missing)}");
        }
        catch (Exception ex)
        {
            return new(
                true,
                false,
                false,
                AgentInfo.HiperSchemaTarget,
                database,
                serverVersion,
                null,
                missing,
                ex.Message);
        }
    }
    // As queries de NF/Pagamento dependem da tabela pedido_venda_operacao_pdv, que so
    // existe em versoes mais novas do Hiper. Cacheamos a existencia pra pular essas
    // queries em silencio em versoes antigas (ex.: Franzoni) — sem logar "Invalid column".
    private bool? _pdvOpExists;

    /// <summary>Checa (1x, cacheado) se a tabela pedido_venda_operacao_pdv existe.</summary>
    private async Task<bool> PdvOperacaoExisteAsync(CancellationToken ct)
    {
        if (_pdvOpExists.HasValue) return _pdvOpExists.Value;
        const string sql = "select 1 from INFORMATION_SCHEMA.TABLES where TABLE_NAME = 'pedido_venda_operacao_pdv'";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        _pdvOpExists = (await cmd.ExecuteScalarAsync(ct)) != null;
        return _pdvOpExists.Value;
    }

    public async Task<List<PedidoHeader>> NovosPedidosAsync(int hwm, short[] situacoes, CancellationToken ct)
    {
        if (situacoes is null || situacoes.Length == 0) return new();
        // placeholders dinâmicos @s0,@s1,... — só NOMES de parâmetro entram na string;
        // os VALORES vão por SqlParameter (sem interpolar dados → sem risco de injeção).
        var nomes = situacoes.Select((_, i) => "@s" + i).ToArray();
        string sql = $@"
SELECT pv.id_pedido_venda, pv.codigo, pv.data_hora_geracao, pv.id_entidade_cliente,
       pv.id_usuario_vendedor, pv.data_previsao_entrega_final, pv.data_previsao_entrega_inicial,
       pv.observacao, pv.valor_frete
FROM pedido_venda pv WITH (NOLOCK)
WHERE pv.excluido = 0 AND pv.situacao IN ({string.Join(",", nomes)}) AND pv.id_pedido_venda > @hwm
ORDER BY pv.id_pedido_venda;";
        var list = new List<PedidoHeader>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        for (int i = 0; i < situacoes.Length; i++)
            cmd.Parameters.AddWithValue(nomes[i], situacoes[i]);
        cmd.Parameters.AddWithValue("@hwm", hwm);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new PedidoHeader
            {
                IdPedidoVenda = r.GetInt32(0),
                Codigo = r.GetString(1),
                DataHoraGeracao = r.GetDateTime(2),
                IdEntidadeCliente = r.GetInt32(3),
                IdUsuarioVendedor = r.IsDBNull(4) ? 0 : Convert.ToInt32(r.GetValue(4)), // id_usuario_vendedor é smallint no Hiper
                DataEntrega = !r.IsDBNull(5) ? r.GetDateTime(5) : (r.IsDBNull(6) ? null : r.GetDateTime(6)),
                DataEntregaInicio = r.IsDBNull(6) ? null : r.GetDateTime(6),
                Observacao = r.IsDBNull(7) ? null : r.GetString(7),
                ValorFrete = r.IsDBNull(8) ? 0m : Convert.ToDecimal(r.GetValue(8)),
            });
        }
        return list;
    }

    public async Task<ClienteRow?> ClienteAsync(int idEntidade, CancellationToken ct)
    {
        const string sql = @"
SELECT e.nome,
       COALESCE(pf.cpf, pj.cnpj) AS cpf_cnpj,
       e.logradouro, e.numero_endereco, e.complemento, e.bairro, e.cep,
       c.nome AS cidade, c.uf, e.fone_primario_ddd, e.fone_primario_numero
FROM entidade e WITH (NOLOCK)
LEFT JOIN pessoa_fisica pf WITH (NOLOCK) ON pf.id_entidade = e.id_entidade
LEFT JOIN pessoa_juridica pj WITH (NOLOCK) ON pj.id_entidade = e.id_entidade
LEFT JOIN cidade c WITH (NOLOCK) ON c.id_cidade = e.id_cidade
WHERE e.id_entidade = @id;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idEntidade);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));
        return new ClienteRow
        {
            Nome = r.GetString(0), CpfCnpj = S(1), Logradouro = S(2), Numero = S(3),
            Complemento = S(4), Bairro = S(5), Cep = S(6), Cidade = S(7), Uf = S(8),
            FoneDdd = S(9), FoneNumero = S(10),
        };
    }

    public async Task<List<ItemRow>> ItensAsync(int idPedido, CancellationToken ct)
    {
        const string sql = @"
SELECT p.codigo, p.nome, g.quantidade, ipv.valor_unitario, ipv.valor_unitario_com_desconto, ipv.id_produto
FROM item_pedido_venda ipv WITH (NOLOCK)
JOIN grade_pedido_venda g WITH (NOLOCK)
  ON g.id_pedido_venda = ipv.id_pedido_venda AND g.sequencia_item = ipv.sequencia_item
JOIN produto p WITH (NOLOCK) ON p.id_produto = ipv.id_produto
WHERE ipv.id_pedido_venda = @id AND ipv.excluido = 0 AND ipv.cancelado = 0
ORDER BY ipv.sequencia_item;";
        var list = new List<ItemRow>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idPedido);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new ItemRow
            {
                Codigo = Convert.ToString(r.GetValue(0)) ?? "",
                Descricao = r.GetString(1),
                Quantidade = r.GetDecimal(2),
                ValorUnitario = r.GetDecimal(3),
                ValorUnitarioComDesconto = r.GetDecimal(4),
                IdProduto = r.IsDBNull(5) ? 0 : Convert.ToInt32(r.GetValue(5)),
            });
        }
        return list;
    }

    /// <summary>
    /// #5 ESTOQUE (best-effort): saldo por id_produto. Chamado em try/catch no Worker —
    /// se o schema de saldo_estoque divergir, loga e segue SEM quebrar o fluxo de pedidos.
    /// Colunas confirmadas no raio-x: saldo_estoque(id_produto, quantidade, excluido).
    /// </summary>
    public async Task<Dictionary<int, decimal>> SaldosAsync(int[] idProdutos, CancellationToken ct)
    {
        var saldos = new Dictionary<int, decimal>();
        var ids = idProdutos.Where(i => i > 0).Distinct().ToArray();
        if (ids.Length == 0) return saldos;
        var nomes = ids.Select((_, i) => "@p" + i).ToArray();
        var sql = $@"
SELECT se.id_produto, SUM(se.quantidade) AS saldo
FROM saldo_estoque se WITH (NOLOCK)
WHERE se.excluido = 0 AND se.id_produto IN ({string.Join(",", nomes)})
GROUP BY se.id_produto;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        for (int i = 0; i < ids.Length; i++) cmd.Parameters.AddWithValue(nomes[i], ids[i]);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            saldos[Convert.ToInt32(r.GetValue(0))] = r.IsDBNull(1) ? 0m : Convert.ToDecimal(r.GetValue(1));
        return saldos;
    }

    /// <summary>
    /// #3 NF-e (best-effort): última NF ligada ao pedido. Chamado em try/catch no Worker.
    /// Cadeia: pedido_venda → pedido_venda_operacao_pdv → operacao_pdv.id_nota_fiscal → nota_fiscal.
    /// VALIDADO no Hiper real Franzoni (2026-06-02): a chave de junção é op.id_operacao = pvo.id_operacao
    /// (NÃO id_operacao_pdv). Se divergir noutro Hiper, o catch no Worker só deixa a NF em branco.
    /// </summary>
    public async Task<(string? Numero, string? Chave, DateTime? Emitida, decimal? Valor)?> NfDoPedidoAsync(int idPedido, CancellationToken ct)
    {
        if (!await PdvOperacaoExisteAsync(ct)) return null; // Hiper antigo: sem essa tabela, sem NF
        const string sql = @"
SELECT TOP 1 nf.numero_documento_fiscal, nf.chave_documento_fiscal, nf.data_hora_emissao, nf.valor_total
FROM pedido_venda_operacao_pdv pvo WITH (NOLOCK)
JOIN operacao_pdv op WITH (NOLOCK) ON op.id_operacao = pvo.id_operacao
JOIN nota_fiscal nf WITH (NOLOCK) ON nf.id_nota_fiscal = op.id_nota_fiscal
WHERE pvo.id_pedido_venda = @id
ORDER BY nf.data_hora_emissao DESC;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idPedido);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return (
            r.IsDBNull(0) ? null : Convert.ToString(r.GetValue(0)),
            r.IsDBNull(1) ? null : Convert.ToString(r.GetValue(1)),
            r.IsDBNull(2) ? null : r.GetDateTime(2),
            r.IsDBNull(3) ? null : Convert.ToDecimal(r.GetValue(3))
        );
    }

    /// <summary>
    /// #2 PAGAMENTO ao finalizar (best-effort): forma + parcelas estruturadas do Hiper.
    /// Confirmado no raio-x: negociacao_finalizador(id_finalizador, numero_parcelas, valor_parcelas)
    /// → finalizador_pdv (catálogo: Dinheiro/Cheque/Cartão/Pix/...). SÓ existe em pedido FINALIZADO.
    /// VALIDADO no Hiper real Franzoni (2026-06-02): negociacao tem id_pedido_venda DIRETO
    ///    (n.id_pedido_venda = @id) — não passa por operacao_pdv. Cadeia: negociacao →
    ///    negociacao_finalizador(id_negociacao, id_finalizador, numero_parcelas, valor_parcelas) → finalizador_pdv.nome.
    /// Pega o finalizador dominante (maior valor) quando há pagamento dividido. Degrada gracioso no catch.
    /// </summary>
    public async Task<(string? Forma, string? Parcelas)?> PagamentoDoPedidoAsync(int idPedido, CancellationToken ct)
    {
        if (!await PdvOperacaoExisteAsync(ct)) return null; // Hiper antigo: sem essa tabela, sem pagamento estruturado
        const string sql = @"
SELECT TOP 1 fp.nome, nfin.numero_parcelas
FROM negociacao n WITH (NOLOCK)
JOIN negociacao_finalizador nfin WITH (NOLOCK) ON nfin.id_negociacao = n.id_negociacao
JOIN finalizador_pdv fp WITH (NOLOCK) ON fp.id_finalizador = nfin.id_finalizador
WHERE n.id_pedido_venda = @id
ORDER BY nfin.valor_parcelas DESC;";
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idPedido);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        var forma = r.IsDBNull(0) ? null : Convert.ToString(r.GetValue(0));
        int? parc = r.IsDBNull(1) ? null : Convert.ToInt32(r.GetValue(1));
        return (forma, parc is > 1 ? $"{parc}x" : null);
    }

    /// <summary>
    /// Self-check de schema: confere no INFORMATION_SCHEMA se as colunas que as queries
    /// usam existem no Hiper. Devolve a lista das que FALTAM (vazia = schema ok). Roda no
    /// startup pra avisar claramente numa versão divergente do Hiper, em vez de quebrar no meio.
    /// </summary>
    public async Task<List<string>> VerificarSchemaAsync(CancellationToken ct)
    {
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        var existing = await ReadSchemaColumnsAsync(cn, ct);
        return GetMissingHiper197Columns(existing);
    }

    // ===== Ordem de Serviço (colunas confirmadas no raio-x do schema) =====
    public async Task<List<OsHeader>> NovasOrdensServicoAsync(int hwm, short[] situacoes, CancellationToken ct)
    {
        var filtro = "";
        if (situacoes.Length > 0)
        {
            var nomes = situacoes.Select((_, i) => "@s" + i).ToArray();
            filtro = $"AND os.situacao IN ({string.Join(",", nomes)})";
        }
        var sql = $@"
SELECT os.id_ordem_servico, os.id_entidade_cliente, os.id_usuario_cadastro,
       os.situacao, os.prioridade, os.data_hora_cadastro, os.data_hora_previsao,
       os.data_hora_finalizacao, os.observacao, c.nome AS categoria,
       obj.defeito_relatado, obj.diagnostico, obj.data_inicial_garantia, obj.data_final_garantia
FROM ordem_servico os WITH (NOLOCK)
LEFT JOIN categoria_ordem_servico c WITH (NOLOCK) ON c.id_categoria_ordem_servico = os.id_categoria_ordem_servico
OUTER APPLY (SELECT TOP 1 o.defeito_relatado, o.diagnostico, o.data_inicial_garantia, o.data_final_garantia
             FROM objeto_ordem_servico o WITH (NOLOCK) WHERE o.id_ordem_servico = os.id_ordem_servico) obj
WHERE os.id_ordem_servico > @hwm {filtro}
ORDER BY os.id_ordem_servico;";
        var list = new List<OsHeader>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@hwm", hwm);
        for (int i = 0; i < situacoes.Length; i++) cmd.Parameters.AddWithValue("@s" + i, situacoes[i]);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        DateTime? D(int i) => r.IsDBNull(i) ? null : r.GetDateTime(i);
        string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));
        while (await r.ReadAsync(ct))
        {
            list.Add(new OsHeader
            {
                IdOrdemServico = r.GetInt32(0),
                IdEntidadeCliente = r.IsDBNull(1) ? 0 : Convert.ToInt32(r.GetValue(1)),
                IdUsuarioResponsavel = r.IsDBNull(2) ? 0 : Convert.ToInt32(r.GetValue(2)),
                Situacao = r.IsDBNull(3) ? null : Convert.ToInt16(r.GetValue(3)),
                Prioridade = r.IsDBNull(4) ? null : Convert.ToInt16(r.GetValue(4)),
                DataAbertura = D(5), DataPrevisao = D(6), DataConclusao = D(7),
                Observacao = S(8), Categoria = S(9),
                DefeitoRelatado = S(10), Diagnostico = S(11),
                GarantiaInicio = D(12), GarantiaFim = D(13),
            });
        }
        return list;
    }

    public async Task<List<IngestItem>> ItensOsAsync(int idOs, CancellationToken ct)
    {
        const string sql = @"
SELECT p.codigo, p.nome, i.quantidade, i.valor_unitario, i.valor_total
FROM item_ordem_servico i WITH (NOLOCK)
JOIN produto p WITH (NOLOCK) ON p.id_produto = i.id_produto
WHERE i.id_ordem_servico = @id;";
        var list = new List<IngestItem>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idOs);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            var vu = r.GetDecimal(3); var vt = r.GetDecimal(4);
            list.Add(new IngestItem
            {
                Codigo = Convert.ToString(r.GetValue(0)) ?? "", Descricao = r.GetString(1),
                Quantidade = r.GetDecimal(2), Unidade = "UN",
                PrecoUnitario = vu, Desconto = 0m, Total = vt,
            });
        }
        return list;
    }

    public async Task<List<OsServicoRow>> ServicosOsAsync(int idOs, CancellationToken ct)
    {
        const string sql = @"
SELECT s.nome, so.quantidade, so.valor_unitario, so.valor_total, u.nome AS tecnico
FROM servico_ordem_servico so WITH (NOLOCK)
JOIN servico s WITH (NOLOCK) ON s.id_servico = so.id_servico
LEFT JOIN usuario u WITH (NOLOCK) ON u.id_usuario = so.id_usuario_tecnico
WHERE so.id_ordem_servico = @id;";
        var list = new List<OsServicoRow>();
        await using var cn = new SqlConnection(_cs);
        await cn.OpenAsync(ct);
        await using var cmd = new SqlCommand(sql, cn);
        cmd.Parameters.AddWithValue("@id", idOs);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            list.Add(new OsServicoRow
            {
                Descricao = r.GetString(0), Quantidade = r.GetDecimal(1),
                ValorUnitario = r.GetDecimal(2), ValorTotal = r.GetDecimal(3),
                TecnicoNome = r.IsDBNull(4) ? null : r.GetString(4),
            });
        }
        return list;
    }
}
