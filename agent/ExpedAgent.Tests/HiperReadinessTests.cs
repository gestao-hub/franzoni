using System.Text.Json;
using ExpedAgent;
using Xunit;

namespace ExpedAgent.Tests;

public sealed class HiperReadinessTests
{
    [Fact]
    public void Schema197CompatibilityReportsMissingColumns()
    {
        var all = HiperRepository.Hiper197RequiredColumns.ToArray();
        var missing = HiperRepository.GetMissingHiper197Columns(all.Skip(1));

        Assert.Single(missing);
        Assert.Equal($"{all[0].Table}.{all[0].Column}", missing[0]);
    }

    [Fact]
    public void ProbeQueryIsReadOnlyAndExercisesPedidoVenda()
    {
        var sql = HiperRepository.Hiper197ReadOnlyProbeSql;

        Assert.Contains("TOP (1)", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("pedido_venda", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("INSERT", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UPDATE", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DELETE", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MERGE", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReadinessJsonKeepsAgentAndHiperSignalsDistinct()
    {
        var snapshot = AgentReadinessSnapshot.Create(
            processId: 197,
            agentVersion: "test",
            new HiperReadiness(
                Connected: true,
                QueryOk: false,
                SchemaCompatible: false,
                TargetSchema: AgentInfo.HiperSchemaTarget,
                Database: "Hiper",
                ServerVersion: "16.0",
                SampleOrderId: null,
                MissingColumns: ["pedido_venda.codigo"],
                Error: "schema divergente"));

        using var json = JsonDocument.Parse(JsonSerializer.Serialize(snapshot));
        Assert.Equal(197, json.RootElement.GetProperty("pid").GetInt32());
        var hiper = json.RootElement.GetProperty("hiper");
        Assert.True(hiper.GetProperty("connected").GetBoolean());
        Assert.False(hiper.GetProperty("queryOk").GetBoolean());
        Assert.False(hiper.GetProperty("schemaCompatible").GetBoolean());
    }
}
