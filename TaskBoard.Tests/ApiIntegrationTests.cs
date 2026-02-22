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
        var items = listJson.RootElement.GetProperty("items");
        var ids = items.EnumerateArray().Select(x => x.GetProperty("id").GetString()).ToList();
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

    [Fact]
    public async Task Invalid_Token_Returns_401()
    {
        using var factory = new TestAppFactory();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "wrong-token");

        var response = await client.GetAsync("/tickets");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Patch_Ticket_Updates_Fields()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Original", "Ready", 1);

        var patchResponse = await client.PatchAsJsonAsync($"/tickets/{ticket}", new
        {
            title = "Updated Title",
            status = "InProgress",
            priority = 5
        });
        Assert.Equal(HttpStatusCode.OK, patchResponse.StatusCode);

        var json = JsonDocument.Parse(await patchResponse.Content.ReadAsStringAsync());
        Assert.Equal("Updated Title", json.RootElement.GetProperty("title").GetString());
        Assert.Equal("InProgress", json.RootElement.GetProperty("status").GetString());
        Assert.Equal(5, json.RootElement.GetProperty("priority").GetInt32());
    }

    [Fact]
    public async Task Heartbeat_Extends_Lock()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Heartbeat target", "Ready", 1);

        var acquireResponse = await client.PostAsJsonAsync("/runs/acquire", new { ticket_id = ticket, owner = "orch-1", ttl_seconds = 10 });
        Assert.Equal(HttpStatusCode.OK, acquireResponse.StatusCode);
        var acquireDoc = JsonDocument.Parse(await acquireResponse.Content.ReadAsStringAsync());
        Assert.True(acquireDoc.RootElement.GetProperty("acquired").GetBoolean());

        var heartbeatResponse = await client.PostAsJsonAsync("/runs/heartbeat", new { ticket_id = ticket, owner = "orch-1", ttl_seconds = 60 });
        Assert.Equal(HttpStatusCode.OK, heartbeatResponse.StatusCode);
        var heartbeatDoc = JsonDocument.Parse(await heartbeatResponse.Content.ReadAsStringAsync());
        Assert.True(heartbeatDoc.RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Validate_Returns_Ok_When_No_Cycle()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var t1 = await CreateTicketAsync(client, "A", "Ready", 1);
        var t2 = await CreateTicketAsync(client, "B", "Ready", 1);
        await PutDepsAsync(client, t2, [t1], HttpStatusCode.NoContent);

        var response = await client.GetAsync("/validate");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(json.RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Validate_Returns_Ok_After_Cycle_Rejected()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var t1 = await CreateTicketAsync(client, "C1", "Ready", 1);
        var t2 = await CreateTicketAsync(client, "C2", "Ready", 1);
        var t3 = await CreateTicketAsync(client, "C3", "Ready", 1);
        await PutDepsAsync(client, t2, [t1], HttpStatusCode.NoContent);
        await PutDepsAsync(client, t3, [t2], HttpStatusCode.NoContent);
        await PutDepsAsync(client, t1, [t3], HttpStatusCode.Conflict);

        var response = await client.GetAsync("/validate");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(json.RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Get_Tickets_With_Filters_And_Pagination()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        await CreateTicketAsync(client, "F1", "Ready", 1);
        await CreateTicketAsync(client, "F2", "Done", 1);
        await CreateTicketAsync(client, "F3", "Ready", 1);

        var response = await client.GetAsync("/tickets?status=Ready&limit=2&offset=0");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(json.RootElement.TryGetProperty("total", out _));
        Assert.Equal(2, json.RootElement.GetProperty("limit").GetInt32());
        Assert.Equal(0, json.RootElement.GetProperty("offset").GetInt32());
        var items = json.RootElement.GetProperty("items");
        Assert.True(items.GetArrayLength() >= 2);
    }

    [Fact]
    public async Task Get_Deps_Batch_Returns_All_Requested()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var t1 = await CreateTicketAsync(client, "D1", "Ready", 1);
        var t2 = await CreateTicketAsync(client, "D2", "Ready", 1);
        await PutDepsAsync(client, t2, [t1], HttpStatusCode.NoContent);

        var response = await client.GetAsync($"/deps?ids={t1},{t2}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var key1 = t1.ToLowerInvariant();
        var key2 = t2.ToLowerInvariant();
        Assert.True(json.RootElement.TryGetProperty(key1, out var deps1));
        Assert.True(json.RootElement.TryGetProperty(key2, out var deps2));
        Assert.Equal(0, deps1.GetProperty("blocked_by").GetArrayLength());
        Assert.Equal(1, deps2.GetProperty("blocked_by").GetArrayLength());
        Assert.Equal(t1, deps2.GetProperty("blocked_by")[0].GetString());
    }

    [Fact]
    public async Task Create_Event_And_Get_Events()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Event ticket", "Ready", 1);

        var createResponse = await client.PostAsJsonAsync("/events", new { ticket_id = ticket, type = "custom.test", payload = new { key = "value" } });
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);

        var getResponse = await client.GetAsync($"/events?ticket_id={ticket}&limit=10");
        Assert.Equal(HttpStatusCode.OK, getResponse.StatusCode);
        var json = JsonDocument.Parse(await getResponse.Content.ReadAsStringAsync());
        var events = json.RootElement.EnumerateArray().ToList();
        Assert.True(events.Count >= 1);
        var hasCustomEvent = events.Any(e => e.GetProperty("type").GetString() == "custom.test");
        Assert.True(hasCustomEvent);
    }

    [Fact]
    public async Task Create_Ticket_With_Empty_Title_Returns_400()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var response = await client.PostAsJsonAsync("/tickets", new { title = "", status = "Ready", priority = 1 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Get_NonExistent_Ticket_Returns_404()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var response = await client.GetAsync("/tickets/NONEXISTENT");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Post_Ticket_Update_Returns_201_And_Event()
    {
        using var factory = new TestAppFactory();
        using var client = CreateAuthedClient(factory);

        var ticket = await CreateTicketAsync(client, "Update target", "Ready", 1);

        var response = await client.PostAsJsonAsync($"/tickets/{ticket}/updates", new { message = "Started working", author = "agent-1" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("ticket.update", json.RootElement.GetProperty("type").GetString());
        Assert.Equal(ticket, json.RootElement.GetProperty("ticket_id").GetString());
        var payload = json.RootElement.GetProperty("payload");
        Assert.Equal("Started working", payload.GetProperty("message").GetString());
        Assert.Equal("agent-1", payload.GetProperty("author").GetString());
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
