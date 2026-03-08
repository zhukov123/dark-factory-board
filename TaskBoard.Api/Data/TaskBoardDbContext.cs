using Microsoft.EntityFrameworkCore;
using TaskBoard.Api.Domain;

namespace TaskBoard.Api.Data;

public sealed class TaskBoardDbContext(DbContextOptions<TaskBoardDbContext> options) : DbContext(options)
{
    public DbSet<TicketEntity> Tickets => Set<TicketEntity>();
    public DbSet<DependencyEntity> Dependencies => Set<DependencyEntity>();
    public DbSet<RunEntity> Runs => Set<RunEntity>();
    public DbSet<AttachmentEntity> Attachments => Set<AttachmentEntity>();
    public DbSet<EventEntity> Events => Set<EventEntity>();
    public DbSet<CounterEntity> Counters => Set<CounterEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<TicketEntity>(entity =>
        {
            entity.ToTable("tickets");
            entity.HasKey(t => t.Id);
            entity.Property(t => t.Id).HasColumnName("id");
            entity.Property(t => t.Title).HasColumnName("title");
            entity.Property(t => t.Status).HasColumnName("status").HasConversion<string>();
            entity.Property(t => t.Priority).HasColumnName("priority");
            entity.Property(t => t.Repo).HasColumnName("repo");
            entity.Property(t => t.LabelsJson).HasColumnName("labels_json");
            entity.Property(t => t.AcceptanceCriteriaJson).HasColumnName("acceptance_criteria_json");
            entity.Property(t => t.TestPlan).HasColumnName("test_plan");
            entity.Property(t => t.Description).HasColumnName("description");
            entity.Property(t => t.CreatedAt).HasColumnName("created_at");
            entity.Property(t => t.UpdatedAt).HasColumnName("updated_at");
            entity.Property(t => t.IsDeleted).HasColumnName("is_deleted");
            entity.Property(t => t.DeletedAt).HasColumnName("deleted_at");
            entity.HasIndex(t => new { t.Status, t.Repo, t.UpdatedAt });
            entity.HasIndex(t => t.IsDeleted);
        });

        modelBuilder.Entity<DependencyEntity>(entity =>
        {
            entity.ToTable("deps");
            entity.HasKey(d => new { d.TicketId, d.BlockedById });
            entity.Property(d => d.TicketId).HasColumnName("ticket_id");
            entity.Property(d => d.BlockedById).HasColumnName("blocked_by_id");
            entity.HasOne(d => d.Ticket)
                .WithMany(t => t.BlockedBy)
                .HasForeignKey(d => d.TicketId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(d => d.BlockedBy)
                .WithMany(t => t.Blocks)
                .HasForeignKey(d => d.BlockedById)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasIndex(d => d.BlockedById);
        });

        modelBuilder.Entity<RunEntity>(entity =>
        {
            entity.ToTable("runs");
            entity.HasKey(r => r.TicketId);
            entity.Property(r => r.TicketId).HasColumnName("ticket_id");
            entity.Property(r => r.Phase).HasColumnName("phase").HasConversion<string>();
            entity.Property(r => r.Attempt).HasColumnName("attempt");
            entity.Property(r => r.LockOwner).HasColumnName("lock_owner");
            entity.Property(r => r.LockExpiresAt).HasColumnName("lock_expires_at");
            entity.Property(r => r.Branch).HasColumnName("branch");
            entity.Property(r => r.PrNumber).HasColumnName("pr_number");
            entity.Property(r => r.LastCiState).HasColumnName("last_ci_state").HasConversion<string>();
            entity.Property(r => r.LastSummary).HasColumnName("last_summary");
            entity.Property(r => r.LastError).HasColumnName("last_error");
            entity.Property(r => r.PendingApprovalDecisionId).HasColumnName("pending_approval_decision_id");
            entity.Property(r => r.WorkflowId).HasColumnName("workflow_id");
            entity.Property(r => r.UpdatedAt).HasColumnName("updated_at");
            entity.HasOne(r => r.Ticket)
                .WithOne(t => t.Run)
                .HasForeignKey<RunEntity>(r => r.TicketId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(r => r.LockExpiresAt);
        });

        modelBuilder.Entity<AttachmentEntity>(entity =>
        {
            entity.ToTable("attachments");
            entity.HasKey(a => a.Id);
            entity.Property(a => a.Id).HasColumnName("id");
            entity.Property(a => a.TicketId).HasColumnName("ticket_id");
            entity.Property(a => a.Name).HasColumnName("name");
            entity.Property(a => a.ContentType).HasColumnName("content_type");
            entity.Property(a => a.Size).HasColumnName("size");
            entity.Property(a => a.StoragePath).HasColumnName("storage_path");
            entity.Property(a => a.CreatedAt).HasColumnName("created_at");
            entity.HasOne(a => a.Ticket)
                .WithMany(t => t.Attachments)
                .HasForeignKey(a => a.TicketId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(a => a.TicketId);
        });

        modelBuilder.Entity<EventEntity>(entity =>
        {
            entity.ToTable("events");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.TicketId).HasColumnName("ticket_id");
            entity.Property(e => e.Type).HasColumnName("type");
            entity.Property(e => e.PayloadJson).HasColumnName("payload_json");
            entity.Property(e => e.CreatedAt).HasColumnName("created_at");
            entity.HasOne(e => e.Ticket)
                .WithMany(t => t.Events)
                .HasForeignKey(e => e.TicketId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(e => new { e.TicketId, e.CreatedAt });
            entity.HasIndex(e => new { e.Type, e.CreatedAt });
        });

        modelBuilder.Entity<CounterEntity>(entity =>
        {
            entity.ToTable("counters");
            entity.HasKey(c => c.Key);
            entity.Property(c => c.Key).HasColumnName("key");
            entity.Property(c => c.Value).HasColumnName("value");
        });
    }
}
