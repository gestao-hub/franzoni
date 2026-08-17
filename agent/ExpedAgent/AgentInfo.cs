namespace ExpedAgent;

/// <summary>Versão do agente — comparada com /api/agent/version pra avisar de atualização.</summary>
public static class AgentInfo
{
    public const string Version = "1.1.0";
    public const string HiperSchemaTarget = "Hiper Loja 197";

    // Contexto informado pelo tecnico: Hiper Loja foi de 195 para 197 na sexta
    // anterior. Isto nao atribui causa sem evidencia. O pedido local existia e
    // o bloqueio observado no incidente estava no sync cloud.
    public const string HiperUpgradeContext =
        "Atualizacao Hiper Loja 195 para 197 na sexta anterior: contexto, nao causa sem evidencia.";
    public const string IncidentContext =
        "Pedido local existia; bloqueio observado estava no sync cloud.";
}
