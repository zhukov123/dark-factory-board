using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Infrastructure;

#nullable disable

namespace TaskBoard.Api.Migrations;

[DbContext(typeof(TaskBoard.Api.Data.TaskBoardDbContext))]
[Migration("202602210001_InitialCreate")]
public partial class InitialCreate : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "counters",
            columns: table => new
            {
                key = table.Column<string>(type: "TEXT", nullable: false),
                value = table.Column<string>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_counters", x => x.key);
            });

        migrationBuilder.CreateTable(
            name: "tickets",
            columns: table => new
            {
                id = table.Column<string>(type: "TEXT", nullable: false),
                title = table.Column<string>(type: "TEXT", nullable: false),
                status = table.Column<string>(type: "TEXT", nullable: false),
                priority = table.Column<int>(type: "INTEGER", nullable: false),
                repo = table.Column<string>(type: "TEXT", nullable: false),
                labels_json = table.Column<string>(type: "TEXT", nullable: false),
                acceptance_criteria_json = table.Column<string>(type: "TEXT", nullable: false),
                test_plan = table.Column<string>(type: "TEXT", nullable: true),
                description = table.Column<string>(type: "TEXT", nullable: true),
                created_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                updated_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                is_deleted = table.Column<bool>(type: "INTEGER", nullable: false),
                deleted_at = table.Column<DateTime>(type: "TEXT", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_tickets", x => x.id);
            });

        migrationBuilder.CreateTable(
            name: "deps",
            columns: table => new
            {
                ticket_id = table.Column<string>(type: "TEXT", nullable: false),
                blocked_by_id = table.Column<string>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_deps", x => new { x.ticket_id, x.blocked_by_id });
                table.ForeignKey(
                    name: "FK_deps_tickets_blocked_by_id",
                    column: x => x.blocked_by_id,
                    principalTable: "tickets",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_deps_tickets_ticket_id",
                    column: x => x.ticket_id,
                    principalTable: "tickets",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateTable(
            name: "events",
            columns: table => new
            {
                id = table.Column<long>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                ticket_id = table.Column<string>(type: "TEXT", nullable: true),
                type = table.Column<string>(type: "TEXT", nullable: false),
                payload_json = table.Column<string>(type: "TEXT", nullable: false),
                created_at = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_events", x => x.id);
                table.ForeignKey(
                    name: "FK_events_tickets_ticket_id",
                    column: x => x.ticket_id,
                    principalTable: "tickets",
                    principalColumn: "id",
                    onDelete: ReferentialAction.SetNull);
            });

        migrationBuilder.CreateTable(
            name: "runs",
            columns: table => new
            {
                ticket_id = table.Column<string>(type: "TEXT", nullable: false),
                phase = table.Column<string>(type: "TEXT", nullable: false),
                attempt = table.Column<int>(type: "INTEGER", nullable: false),
                lock_owner = table.Column<string>(type: "TEXT", nullable: true),
                lock_expires_at = table.Column<DateTime>(type: "TEXT", nullable: true),
                branch = table.Column<string>(type: "TEXT", nullable: true),
                pr_number = table.Column<int>(type: "INTEGER", nullable: true),
                last_ci_state = table.Column<string>(type: "TEXT", nullable: false),
                last_summary = table.Column<string>(type: "TEXT", nullable: true),
                last_error = table.Column<string>(type: "TEXT", nullable: true),
                updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_runs", x => x.ticket_id);
                table.ForeignKey(
                    name: "FK_runs_tickets_ticket_id",
                    column: x => x.ticket_id,
                    principalTable: "tickets",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_deps_blocked_by_id",
            table: "deps",
            column: "blocked_by_id");

        migrationBuilder.CreateIndex(
            name: "IX_events_ticket_id_created_at",
            table: "events",
            columns: new[] { "ticket_id", "created_at" });

        migrationBuilder.CreateIndex(
            name: "IX_events_type_created_at",
            table: "events",
            columns: new[] { "type", "created_at" });

        migrationBuilder.CreateIndex(
            name: "IX_runs_lock_expires_at",
            table: "runs",
            column: "lock_expires_at");

        migrationBuilder.CreateIndex(
            name: "IX_tickets_is_deleted",
            table: "tickets",
            column: "is_deleted");

        migrationBuilder.CreateIndex(
            name: "IX_tickets_status_repo_updated_at",
            table: "tickets",
            columns: new[] { "status", "repo", "updated_at" });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "counters");
        migrationBuilder.DropTable(name: "deps");
        migrationBuilder.DropTable(name: "events");
        migrationBuilder.DropTable(name: "runs");
        migrationBuilder.DropTable(name: "tickets");
    }
}
