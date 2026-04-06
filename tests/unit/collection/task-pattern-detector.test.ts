import { describe, it, expect, beforeEach } from "@jest/globals";
import Database from "better-sqlite3";
import { TaskPatternDetector, SkillCreationRecommendation } from "../../../src/collection/task-pattern-detector.js";

describe("TaskPatternDetector", () => {
  let db: Database.Database;
  let detector: TaskPatternDetector;

  beforeEach(() => {
    // Create an in-memory database for each test
    db = new Database(":memory:");
    
    // Create the evolution_turns table
    db.exec(`
      CREATE TABLE evolution_turns (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        episode_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        system_prompt TEXT,
        user_message TEXT NOT NULL,
        context_json TEXT,
        action_type TEXT NOT NULL CHECK(action_type IN ('tool_call', 'response', 'error', 'subagent_spawn')),
        action_json TEXT NOT NULL,
        outcome_type TEXT NOT NULL CHECK(outcome_type IN ('success', 'failure', 'partial', 'error')),
        outcome_json TEXT NOT NULL,
        reward_signal REAL,
        skills_used TEXT NOT NULL,
        target_skill TEXT
      )
    `);

    detector = new TaskPatternDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Helper to insert a turn into the database
   */
  function insertTurn(
    id: string,
    userMessage: string,
    actionJson: string,
    targetSkill: string | null = null,
    outcomeType: string = "success"
  ): void {
    const stmt = db.prepare(`
      INSERT INTO evolution_turns (
        id, session_key, turn_number, episode_id, timestamp,
        user_message, action_type, action_json, outcome_type, outcome_json, skills_used, target_skill
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      "test-session",
      1,
      "test-episode",
      new Date().toISOString(),
      userMessage,
      "tool_call",
      actionJson,
      outcomeType,
      '{"result": "ok"}',
      "[]",
      targetSkill
    );
  }

  describe("analyze", () => {
    it("should return empty array when no unattributed successful turns exist", () => {
      const recommendations = detector.analyze();
      expect(recommendations).toEqual([]);
    });

    it("should return empty array when fewer than 5 matching turns exist", () => {
      // Insert 4 turns with similar patterns (below the 5+ threshold)
      for (let i = 0; i < 4; i++) {
        insertTurn(
          `turn-${i}`,
          "Please clone the git repository and checkout the branch",
          '{"tools": [{"name": "exec"}, {"name": "read"}]}',
          null, // no target_skill
          "success"
        );
      }

      const recommendations = detector.analyze();
      expect(recommendations).toEqual([]);
    });

    it("should detect git workflow pattern with 5+ similar turns", () => {
      // Insert 10 turns with git-related keywords
      // Each message shares at least 2 keywords with others for clustering
      const gitMessages = [
        "Clone git repository from remote origin",
        "Checkout git branch from remote repository",
        "Commit changes to git repository",
        "Push git changes to remote origin",
        "Pull from git remote repository origin",
        "Fetch git remote origin updates",
        "Merge git repository branch changes",
        "Rebase git repository onto main",
        "Stash git changes temporarily",
        "Tag git repository release version",
      ];

      for (let i = 0; i < 10; i++) {
        insertTurn(
          `git-turn-${i}`,
          gitMessages[i],
          '{"tools": [{"name": "exec"}, {"name": "read"}]}',
          null,
          "success"
        );
      }

      const recommendations = detector.analyze();
      
      expect(recommendations.length).toBeGreaterThan(0);
      
      const gitRec = recommendations.find(r => 
        r.suggestedSkillName.includes("git") || 
        r.pattern.toLowerCase().includes("git")
      );
      
      expect(gitRec).toBeDefined();
      expect(gitRec!.occurrences).toBeGreaterThanOrEqual(5);
      expect(gitRec!.suggestedSkillName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(gitRec!.confidence).toBeGreaterThan(0);
      expect(gitRec!.confidence).toBeLessThanOrEqual(1);
      expect(gitRec!.examplePrompts.length).toBeGreaterThan(0);
      expect(gitRec!.examplePrompts.length).toBeLessThanOrEqual(3);
    });

    it("should not include turns with target_skill set", () => {
      // Insert 3 unattributed turns
      for (let i = 0; i < 3; i++) {
        insertTurn(
          `unattributed-${i}`,
          "Deploy the application to production server",
          '{"tools": [{"name": "exec"}]}',
          null,
          "success"
        );
      }

      // Insert 3 attributed turns (should not count)
      for (let i = 0; i < 3; i++) {
        insertTurn(
          `attributed-${i}`,
          "Deploy the application to production server",
          '{"tools": [{"name": "exec"}]}',
          "deployment",
          "success"
        );
      }

      const recommendations = detector.analyze();
      // Should not detect pattern because only 3 unattributed turns
      expect(recommendations.length).toBe(0);
    });

    it("should not include failed turns", () => {
      // Insert 3 successful unattributed turns
      for (let i = 0; i < 3; i++) {
        insertTurn(
          `success-${i}`,
          "Analyze the codebase structure",
          '{"tools": [{"name": "read"}]}',
          null,
          "success"
        );
      }

      // Insert 3 failed unattributed turns (should not count)
      for (let i = 0; i < 3; i++) {
        insertTurn(
          `failure-${i}`,
          "Analyze the codebase structure",
          '{"tools": [{"name": "read"}]}',
          null,
          "failure"
        );
      }

      const recommendations = detector.analyze();
      // Should not detect pattern because only 3 successful turns
      expect(recommendations.length).toBe(0);
    });

    it("should sort recommendations by occurrences descending", () => {
      // Insert 7 docker-related turns
      for (let i = 0; i < 7; i++) {
        insertTurn(
          `docker-turn-${i}`,
          "Build docker container and push to registry",
          '{"tools": [{"name": "exec"}]}',
          null,
          "success"
        );
      }

      // Insert 5 kubernetes-related turns
      for (let i = 0; i < 5; i++) {
        insertTurn(
          `k8s-turn-${i}`,
          "Deploy kubernetes pod to cluster",
          '{"tools": [{"name": "exec"}]}',
          null,
          "success"
        );
      }

      const recommendations = detector.analyze();
      
      // Should have at least 2 recommendations
      expect(recommendations.length).toBeGreaterThanOrEqual(2);
      
      // Check that they're sorted by occurrences descending
      for (let i = 1; i < recommendations.length; i++) {
        expect(recommendations[i - 1].occurrences).toBeGreaterThanOrEqual(
          recommendations[i].occurrences
        );
      }
    });

    it("should generate kebab-case skill names", () => {
      // Insert 5 turns with a clear pattern
      for (let i = 0; i < 5; i++) {
        insertTurn(
          `test-turn-${i}`,
          "Database migration scripts execution",
          '{"tools": [{"name": "exec"}]}',
          null,
          "success"
        );
      }

      const recommendations = detector.analyze();
      
      expect(recommendations.length).toBeGreaterThan(0);
      
      // Check that skill names are kebab-case
      for (const rec of recommendations) {
        expect(rec.suggestedSkillName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    });

    it("should include up to 3 example prompts", () => {
      // Insert 10 turns with similar patterns
      for (let i = 0; i < 10; i++) {
        insertTurn(
          `example-turn-${i}`,
          `Test automation script number ${i}`,
          '{"tools": [{"name": "exec"}]}',
          null,
          "success"
        );
      }

      const recommendations = detector.analyze();
      
      expect(recommendations.length).toBeGreaterThan(0);
      
      for (const rec of recommendations) {
        expect(rec.examplePrompts.length).toBeLessThanOrEqual(3);
        expect(rec.examplePrompts.length).toBeGreaterThan(0);
      }
    });

    it("should handle empty target_skill string same as NULL", () => {
      // Insert 5 turns with empty string target_skill
      for (let i = 0; i < 5; i++) {
        const stmt = db.prepare(`
          INSERT INTO evolution_turns (
            id, session_key, turn_number, episode_id, timestamp,
            user_message, action_type, action_json, outcome_type, outcome_json, skills_used, target_skill
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          `empty-skill-${i}`,
          "test-session",
          1,
          "test-episode",
          new Date().toISOString(),
          "Configure nginx web server",
          "tool_call",
          '{"tools": [{"name": "exec"}]}',
          "success",
          '{"result": "ok"}',
          "[]",
          "" // empty string, should be treated as no skill
        );
      }

      const recommendations = detector.analyze();
      
      // Should detect the pattern
      expect(recommendations.length).toBeGreaterThan(0);
    });
  });
});
