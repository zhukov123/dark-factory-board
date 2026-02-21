using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace TaskBoard.Tests;

public sealed class TestAppFactory : WebApplicationFactory<Program>
{
    public const string Token = "test-token";
    public string DatabasePath { get; } = Path.Combine(Path.GetTempPath(), $"taskboard-tests-{Guid.NewGuid():N}.db");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, config) =>
        {
            var overrides = new Dictionary<string, string?>
            {
                ["ConnectionStrings:Default"] = $"Data Source={DatabasePath}",
                ["TaskBoard:AuthToken"] = Token
            };
            config.AddInMemoryCollection(overrides);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && File.Exists(DatabasePath))
        {
            File.Delete(DatabasePath);
        }
    }
}
