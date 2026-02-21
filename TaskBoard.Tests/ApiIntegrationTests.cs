using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace TaskBoard.Tests;

public sealed class ApiIntegrationTests
{
    [Fact]
    public async Task Missing_Auth_Returns_401()
    {
        using var factory = new TestAppFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/tickets");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Deps_Update_Rejects_Cycle_With_409()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var t1 = await CreateTicketAsync(client, "T1", "Ready", 1);
        var t2 = await CreateTicketAsync(client, "T2", "Ready", 1);
        var t3 = await CreateTicketAsync(client, "T3", "Ready", 1);

        await PutDepsAsync(client, t2, [t1], HttpStatusCode.NoContent);
        await PutDepsAsync(client, t3, [t2], HttpStatusCode.NoContent);

        var cycleResponse = await PutDepsAsync(client, t1, [t3], HttpStatusCode.Conflict);
        var json = JsonDocument.Parse(await cycleResponse.Content.ReadAsStringAsync());

        Assert.True(json.RootElement.TryGetProperty("cycle", out var cycle));
        Assert.True(cycle.GetArrayLength() >= 3);
    }

    [Fact]
    public async Task Eligibility_Requires_Blockers_Done()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var blocker = await CreateTicketAsync(client, "Blocker", "Ready", 1);
        var blocked = await CreateTicketAsync(client, "Blocked", "Ready", 1);

        await PutDepsAsync(client, blocked, [blocker], HttpStatusCode.NoContent);

        var initialEligible = await GetEligibleIdsAsync(client);
        Assert.DoesNotContain(blocked, initialEligible);

        await TransitionAsync(client, blocker, "Done", force: false, HttpStatusCode.OK);

        var updatedEligible = await GetEligibleIdsAsync(client);
        Assert.Contains(blocked, updatedEligible);
    }

    [Fact]
    public async Task Lock_Acquire_And_Expiry_Work()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Lock target", "Ready", 1);

        var first = await client.PostAsJsonAsync("/runs/acquire", new { ticket_id = ticket, owner = "orch-1", ttl_seconds = 1 });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstDoc = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        Assert.True(firstDoc.RootElement.GetProperty("acquired").GetBoolean());

        var second = await client.PostAsJsonAsync("/runs/acquire", new { ticket_id = ticket, owner = "orch-2", ttl_seconds = 60 });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var secondDoc = JsonDocument.Parse(await second.Content.ReadAsStringAsync());
        Assert.False(secondDoc.RootElement.GetProperty("acquired").GetBoolean());

        await Task.Delay(1200);

        var third = await client.PostAsJsonAsync("/runs/acquire", new { ticket_id = ticket, owner = "orch-2", ttl_seconds = 60 });
        Assert.Equal(HttpStatusCode.OK, third.StatusCode);
        var thirdDoc = JsonDocument.Parse(await third.Content.ReadAsStringAsync());
        Assert.True(thirdDoc.RootElement.GetProperty("acquired").GetBoolean());
    }

    [Fact]
    public async Task PickNext_Returns_Expected_Ticket()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var a = await CreateTicketAsync(client, "A", "Done", 1);
        var b = await CreateTicketAsync(client, "B", "Ready", 10);
        var c = await CreateTicketAsync(client, "C", "Ready", 1);
        var d = await CreateTicketAsync(client, "D", "Ready", 1);

        await PutDepsAsync(client, c, [a], HttpStatusCode.NoContent);
        await PutDepsAsync(client, d, [b], HttpStatusCode.NoContent);

        var response = await client.GetAsync("/pick-next");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var picked = json.RootElement.GetProperty("ticket_id").GetString();

        Assert.Equal(b, picked);
    }

    [Fact]
    public async Task SoftDelete_Excludes_Ticket_From_List()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Delete me", "Ready", 1);

        var deleteResponse = await client.DeleteAsync($"/tickets/{ticket}");
        Assert.Equal(HttpStatusCode.NoContent, deleteResponse.StatusCode);

        var getResponse = await client.GetAsync($"/tickets/{ticket}");
        Assert.Equal(HttpStatusCode.NotFound, getResponse.StatusCode);

        var listResponse = await client.GetAsync("/tickets");
        var listJson = JsonDocument.Parse(await listResponse.Content.ReadAsStringAsync());
        var ids = listJson.RootElement.EnumerateArray().Select(x => x.GetProperty("id").GetString()).ToList();
        Assert.DoesNotContain(ticket, ids);
    }

    [Fact]
    public async Task Transition_Done_To_InProgress_Requires_Force()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Transition", "Done", 1);

        var denied = await TransitionAsync(client, ticket, "InProgress", force: false, HttpStatusCode.BadRequest);
        Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);

        var allowed = await TransitionAsync(client, ticket, "InProgress", force: true, HttpStatusCode.OK);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    private static HttpClient CreateAuthedClient(TestAppFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestAppFactory.Token);
        return client;
    }

    private static async Task<string> CreateTicketAsync(HttpClient client, string title, string status, int priority)
    {
        var response = await client.PostAsJsonAsync("/tickets", new
        {
            title,
            status,
            priority,
            repo = "repo-a",
            labels = new[] { "core" },
            acceptanceCriteria = new[] { "works" },
            testPlan = "tests",
            description = "desc"
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return json.RootElement.GetProperty("id").GetString()!;
    }

    private static async Task<HttpResponseMessage> PutDepsAsync(HttpClient client, string ticketId, IEnumerable<string> blockedBy, HttpStatusCode expected)
    {
        var response = await client.PutAsJsonAsync($"/tickets/{ticketId}/deps", new { blocked_by = blockedBy.ToArray() });
        Assert.Equal(expected, response.StatusCode);
        return response;
    }

    private static async Task<HttpResponseMessage> TransitionAsync(HttpClient client, string ticketId, string to, bool force, HttpStatusCode expected)
    {
        var response = await client.PostAsJsonAsync($"/tickets/{ticketId}/transition", new { to, note = "n", by = "user", force });
        Assert.Equal(expected, response.StatusCode);
        return response;
    }

    private static async Task<List<string>> GetEligibleIdsAsync(HttpClient client)
    {
        var response = await client.GetAsync("/eligible");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return json.RootElement
            .EnumerateArray()
            .Select(x => x.GetProperty("ticket_id").GetString()!)
            .ToList();
    }
}
