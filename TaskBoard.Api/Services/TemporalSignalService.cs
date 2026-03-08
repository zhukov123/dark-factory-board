using Temporalio.Client;

namespace TaskBoard.Api.Services;

/// <summary>
/// Optional Temporal client used by the API to signal workflows on approve/reject.
/// When Temporal:Host is not set, all operations are no-ops and the service returns false.
/// </summary>
public sealed class TemporalSignalService
{
    private readonly string? _host;
    private readonly string _namespace;
    private ITemporalClient? _client;
    private readonly SemaphoreSlim _connectLock = new(1, 1);

    public TemporalSignalService(IConfiguration configuration)
    {
        _host = configuration["Temporal:Host"] ?? configuration["TEMPORAL_HOST"];
        _namespace = configuration["Temporal:Namespace"] ?? configuration["TEMPORAL_NAMESPACE"] ?? "default";
    }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(_host);

    private async Task<ITemporalClient?> GetClientAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(_host))
            return null;

        if (_client != null)
            return _client;

        await _connectLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_client != null)
                return _client;

            var options = new TemporalClientConnectOptions
            {
                TargetHost = _host.Trim(),
                Namespace = _namespace
            };
            _client = await TemporalClient.ConnectAsync(options).ConfigureAwait(false);
            return _client;
        }
        catch
        {
            return null;
        }
        finally
        {
            _connectLock.Release();
        }
    }

    /// <summary>
    /// Sends an Approve or Reject signal to the workflow. Returns true if the signal was sent.
    /// </summary>
    public async Task<bool> SignalApprovalAsync(string workflowId, string decisionId, string? note, bool approve, CancellationToken cancellationToken = default)
    {
        var client = await GetClientAsync(cancellationToken).ConfigureAwait(false);
        if (client == null)
            return false;

        try
        {
            var handle = client.GetWorkflowHandle(workflowId, null, null);
            var signalName = approve ? "Approve" : "Reject";
            var args = new object[] { decisionId, note ?? string.Empty };
            await handle.SignalAsync(signalName, args, new WorkflowSignalOptions()).ConfigureAwait(false);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
