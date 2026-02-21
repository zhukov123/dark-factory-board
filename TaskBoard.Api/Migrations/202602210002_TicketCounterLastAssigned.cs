using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TaskBoard.Api.Migrations;

[Migration("202602210002_TicketCounterLastAssigned")]
public partial class TicketCounterLastAssigned : Migration
{
    /// <summary>
    /// Converts ticket_next_number from "next id to assign" to "last assigned id"
    /// so that atomic UPDATE ... RETURNING in TicketIdService produces correct IDs.
    /// </summary>
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql(
            "UPDATE counters SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = 'ticket_next_number' AND CAST(value AS INTEGER) > 0");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql(
            "UPDATE counters SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'ticket_next_number'");
    }
}
