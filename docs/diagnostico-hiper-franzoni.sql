/* ============================================================================
   DIAGNÓSTICO SELECT-ONLY DO HIPER — Franzoni (passo 1 do go-live)
   ----------------------------------------------------------------------------
   OBJETIVO: confirmar, ANTES de instalar o agente, que o SQL Server do Hiper
   real da Franzoni bate com o que o agente .NET lê (agent/ExpedAgent/HiperRepository.cs).
   GARANTIA: tudo aqui é SELECT / leitura de catálogo. NENHUM INSERT/UPDATE/DELETE/DDL.
            Pode rodar em produção sem risco. Roda fora de transação, sem locks
            (todas as leituras de dado usam WITH (NOLOCK)).

   COMO USAR (via AnyDesk no servidor da Franzoni):
   - BLOCO 0 roda no CMD/PowerShell (descoberta de instância/ferramenta).
   - BLOCOS 1..7 rodam no SSMS (cole e execute por bloco) OU no sqlcmd.
   - Rode um bloco, copie o resultado e me mande. Eu reajo a cada retorno.
   ========================================================================== */


/* ============================================================================
   BLOCO 0 — DESCOBRIR AMBIENTE  (rodar no CMD, NÃO é SQL)
   Cole cada linha no Prompt de Comando (cmd.exe). Me mande as saídas.
   ----------------------------------------------------------------------------
   :: Existe sqlcmd?
   where sqlcmd

   :: Quais instâncias SQL Server estão instaladas? (registro — leitura)
   reg query "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL"

   :: Serviços do SQL Server rodando (nome da instância aparece aqui)
   sc query type= service state= all | findstr /I "MSSQL"

   :: (se 'where sqlcmd' achou) listar instâncias na rede
   sqlcmd -L
   ----------------------------------------------------------------------------
   Hiper normalmente usa instância nomeada e Windows Auth. Padrões comuns:
     Server=.\HIPER   |   Server=(local)\SQLEXPRESS   |   Server=localhost\HIPER
   Depois de identificar a instância <INST>, conecte assim no sqlcmd
   (autenticação Windows = -E):
     sqlcmd -S .\<INST> -E
   No SSMS: Server name = .\<INST>, Authentication = Windows Authentication.
   ========================================================================== */


/* ============================================================================
   BLOCO 1 — ACHAR O BANCO DO HIPER
   Roda já conectado à instância (qualquer banco). Identifica qual database
   contém as tabelas do Hiper (tem a tabela pedido_venda).
   ========================================================================== */
SELECT @@VERSION AS sql_server_version;
SELECT @@SERVERNAME AS server_name, SERVERPROPERTY('InstanceName') AS instancia;

-- bancos que têm a tabela 'pedido_venda' (o banco do Hiper é o que retornar aqui):
SELECT d.name AS banco_candidato
FROM sys.databases d
WHERE d.state = 0  -- ONLINE
  AND EXISTS (
    SELECT 1 FROM sys.tables t
    WHERE t.name = 'pedido_venda'
      AND OBJECT_NAME(t.object_id, d.database_id) IS NOT NULL
  );
-- Se a linha acima não funcionar na sua versão, rode o fallback abaixo banco a banco:
--   SELECT name FROM sys.databases WHERE state = 0 ORDER BY name;
-- e depois, dentro do banco suspeito:
--   SELECT COUNT(*) FROM sys.tables WHERE name = 'pedido_venda';

/* >>> A PARTIR DAQUI, troque <HIPER_DB> pelo banco identificado e rode:  USE <HIPER_DB>;
   (no sqlcmd, conecte com -d <HIPER_DB>)  <<< */


/* ============================================================================
   BLOCO 2 — VERSÃO DO HIPER (novo vs antigo)
   pedido_venda_operacao_pdv só existe no Hiper NOVO. Define se Pagamento/NF-e
   estruturados vão funcionar (HiperRepository.PagamentoDoPedidoAsync / NfDoPedidoAsync).
   ========================================================================== */
-- USE <HIPER_DB>;
SELECT
  IIF(OBJECT_ID('dbo.pedido_venda_operacao_pdv') IS NOT NULL, 'SIM (Hiper novo)', 'NAO (Hiper antigo)') AS tem_pdv_operacao,
  IIF(OBJECT_ID('dbo.negociacao')               IS NOT NULL, 'SIM', 'NAO') AS tem_negociacao,
  IIF(OBJECT_ID('dbo.negociacao_finalizador')   IS NOT NULL, 'SIM', 'NAO') AS tem_negociacao_finalizador,
  IIF(OBJECT_ID('dbo.finalizador_pdv')          IS NOT NULL, 'SIM', 'NAO') AS tem_finalizador_pdv,
  IIF(OBJECT_ID('dbo.nota_fiscal')              IS NOT NULL, 'SIM', 'NAO') AS tem_nota_fiscal,
  IIF(OBJECT_ID('dbo.operacao_pdv')             IS NOT NULL, 'SIM', 'NAO') AS tem_operacao_pdv,
  IIF(OBJECT_ID('dbo.saldo_estoque')            IS NOT NULL, 'SIM', 'NAO') AS tem_saldo_estoque;


/* ============================================================================
   BLOCO 3 — SELF-CHECK DE SCHEMA (o mais importante)
   Replica HiperRepository.VerificarSchemaAsync: lista as colunas que o agente
   USA mas que NÃO existem no Hiper deles. Resultado VAZIO = schema 100% ok.
   Qualquer linha = ajustar o agente antes de instalar.
   ========================================================================== */
-- USE <HIPER_DB>;
;WITH esperado(tabela, coluna) AS (
  SELECT v.tabela, v.coluna FROM (VALUES
    ('pedido_venda','id_pedido_venda'),('pedido_venda','codigo'),('pedido_venda','situacao'),
    ('pedido_venda','data_hora_geracao'),('pedido_venda','id_entidade_cliente'),
    ('pedido_venda','id_usuario_vendedor'),('pedido_venda','data_previsao_entrega_final'),
    ('pedido_venda','data_previsao_entrega_inicial'),('pedido_venda','observacao'),
    ('pedido_venda','valor_frete'),('pedido_venda','excluido'),
    ('entidade','nome'),('entidade','logradouro'),('entidade','numero_endereco'),('entidade','complemento'),
    ('entidade','bairro'),('entidade','cep'),('entidade','fone_primario_ddd'),
    ('entidade','fone_primario_numero'),('entidade','id_cidade'),
    ('pessoa_fisica','cpf'),('pessoa_juridica','cnpj'),
    ('cidade','nome'),('cidade','uf'),('cidade','id_cidade'),
    ('item_pedido_venda','sequencia_item'),('item_pedido_venda','id_produto'),
    ('item_pedido_venda','valor_unitario'),('item_pedido_venda','valor_unitario_com_desconto'),
    ('item_pedido_venda','excluido'),('item_pedido_venda','cancelado'),
    ('grade_pedido_venda','quantidade'),('grade_pedido_venda','sequencia_item'),
    ('grade_pedido_venda','id_pedido_venda'),
    ('produto','codigo'),('produto','nome'),('produto','id_produto')
  ) AS v(tabela, coluna)
)
SELECT e.tabela, e.coluna AS coluna_FALTANDO
FROM esperado e
LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
  ON c.TABLE_NAME = e.tabela AND c.COLUMN_NAME = e.coluna
WHERE c.COLUMN_NAME IS NULL
ORDER BY e.tabela, e.coluna;
-- >>> VAZIO = perfeito. Linhas = essas colunas precisam de ajuste no agente. <<<


/* ============================================================================
   BLOCO 3b — SELF-CHECK das colunas INFERIDAS (pagamento/NF estruturados)
   Marcadas como "INFERIDO" no HiperRepository.cs (linhas 149-153 e 182-186).
   Só rode se BLOCO 2 disse que tem pdv_operacao. Falha aqui NÃO quebra pedido
   (degrada gracioso pro PDF), mas se vier vazio, pagamento/NF saem automáticos.
   ========================================================================== */
-- USE <HIPER_DB>;
;WITH esperado(tabela, coluna) AS (
  SELECT v.tabela, v.coluna FROM (VALUES
    ('pedido_venda_operacao_pdv','id_pedido_venda'),('pedido_venda_operacao_pdv','id_operacao_pdv'),
    ('operacao_pdv','id_operacao_pdv'),('operacao_pdv','id_nota_fiscal'),
    ('nota_fiscal','id_nota_fiscal'),('nota_fiscal','numero_documento_fiscal'),
    ('nota_fiscal','chave_documento_fiscal'),('nota_fiscal','data_hora_emissao'),('nota_fiscal','valor_total'),
    ('negociacao','id_negociacao'),('negociacao','id_operacao_pdv'),
    ('negociacao_finalizador','id_negociacao'),('negociacao_finalizador','id_finalizador'),
    ('negociacao_finalizador','numero_parcelas'),('negociacao_finalizador','valor_parcelas'),
    ('finalizador_pdv','id_finalizador'),('finalizador_pdv','nome'),
    ('saldo_estoque','id_produto'),('saldo_estoque','quantidade'),('saldo_estoque','excluido')
  ) AS v(tabela, coluna)
)
SELECT e.tabela, e.coluna AS coluna_FALTANDO
FROM esperado e
LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
  ON c.TABLE_NAME = e.tabela AND c.COLUMN_NAME = e.coluna
WHERE c.COLUMN_NAME IS NULL
ORDER BY e.tabela, e.coluna;


/* ============================================================================
   BLOCO 4 — LER 1 PEDIDO REAL PONTA-A-PONTA
   Pega o pedido de venda mais recente (não excluído) e mostra header + cliente
   + itens, EXATAMENTE como o agente monta. Compare com o que está no Hiper na tela.
   ========================================================================== */
-- USE <HIPER_DB>;
DECLARE @id INT = (
  SELECT TOP 1 pv.id_pedido_venda
  FROM pedido_venda pv WITH (NOLOCK)
  WHERE pv.excluido = 0
  ORDER BY pv.id_pedido_venda DESC
);
SELECT @id AS id_pedido_escolhido;

-- 4a) HEADER (igual NovosPedidosAsync)
SELECT pv.id_pedido_venda, pv.codigo, pv.situacao, pv.data_hora_geracao, pv.id_entidade_cliente,
       pv.id_usuario_vendedor, pv.data_previsao_entrega_final, pv.data_previsao_entrega_inicial,
       pv.valor_frete, pv.observacao
FROM pedido_venda pv WITH (NOLOCK)
WHERE pv.id_pedido_venda = @id;

-- 4b) CLIENTE (igual ClienteAsync)
SELECT e.nome,
       COALESCE(pf.cpf, pj.cnpj) AS cpf_cnpj,
       e.logradouro, e.numero_endereco, e.complemento, e.bairro, e.cep,
       c.nome AS cidade, c.uf, e.fone_primario_ddd, e.fone_primario_numero
FROM pedido_venda pv WITH (NOLOCK)
JOIN entidade e WITH (NOLOCK) ON e.id_entidade = pv.id_entidade_cliente
LEFT JOIN pessoa_fisica   pf WITH (NOLOCK) ON pf.id_entidade = e.id_entidade
LEFT JOIN pessoa_juridica pj WITH (NOLOCK) ON pj.id_entidade = e.id_entidade
LEFT JOIN cidade          c  WITH (NOLOCK) ON c.id_cidade   = e.id_cidade
WHERE pv.id_pedido_venda = @id;

-- 4c) ITENS (igual ItensAsync)
SELECT p.codigo, p.nome, g.quantidade, ipv.valor_unitario, ipv.valor_unitario_com_desconto, ipv.id_produto
FROM item_pedido_venda ipv WITH (NOLOCK)
JOIN grade_pedido_venda g WITH (NOLOCK)
  ON g.id_pedido_venda = ipv.id_pedido_venda AND g.sequencia_item = ipv.sequencia_item
JOIN produto p WITH (NOLOCK) ON p.id_produto = ipv.id_produto
WHERE ipv.id_pedido_venda = @id AND ipv.excluido = 0 AND ipv.cancelado = 0
ORDER BY ipv.sequencia_item;


/* ============================================================================
   BLOCO 5 — DISTRIBUIÇÃO DE SITUAÇÃO (confirmar gatilhos de ingestão)
   O agente só puxa pedidos cuja situacao está em SituacoesGatilho (default "2,5,7").
   Aqui vemos quais valores de situacao realmente existem e quantos pedidos há em cada.
   Com isso confirmamos com a Franzoni quais status devem disparar a ingestão.
   ========================================================================== */
-- USE <HIPER_DB>;
SELECT pv.situacao, COUNT(*) AS qtd_pedidos,
       MIN(pv.data_hora_geracao) AS mais_antigo,
       MAX(pv.data_hora_geracao) AS mais_recente
FROM pedido_venda pv WITH (NOLOCK)
WHERE pv.excluido = 0
GROUP BY pv.situacao
ORDER BY pv.situacao;

SELECT COUNT(*) AS total_pedidos_nao_excluidos FROM pedido_venda WITH (NOLOCK) WHERE excluido = 0;


/* ============================================================================
   BLOCO 6 — VENDEDORES (montar hiper_vendedor_map)
   id_usuario_vendedor do pedido precisa mapear pro vendedor no Exped. Hoje só
   há 1 vendedor mapeado na nuvem, mas a Franzoni tem vendas1..4. Lista os usuários
   que aparecem como vendedores em pedidos recentes pra montarmos o mapa completo.
   ========================================================================== */
-- USE <HIPER_DB>;
SELECT u.id_usuario, u.nome,
       COUNT(pv.id_pedido_venda) AS qtd_pedidos
FROM usuario u WITH (NOLOCK)
JOIN pedido_venda pv WITH (NOLOCK)
  ON pv.id_usuario_vendedor = u.id_usuario AND pv.excluido = 0
GROUP BY u.id_usuario, u.nome
ORDER BY qtd_pedidos DESC;
