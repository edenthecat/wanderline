-- Wanderline Database Schema

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Story data for each project (JSON storage for flexibility)
CREATE TABLE IF NOT EXISTS project_stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    story_graph JSONB NOT NULL,
    ink_source TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id)
);

-- Project settings
CREATE TABLE IF NOT EXISTS project_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id)
);

-- Characters table (for character-specific audio libraries)
CREATE TABLE IF NOT EXISTS characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(7) DEFAULT '#9c27b0',
    theme VARCHAR(20) DEFAULT 'purple' CHECK (theme IN ('red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_characters_project_id ON characters(project_id);

-- Add theme column to characters if it doesn't exist (for existing databases)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'characters' AND column_name = 'theme') THEN
        ALTER TABLE characters ADD COLUMN theme VARCHAR(20) DEFAULT 'purple';
    END IF;
END $$;

-- Audio files table
CREATE TABLE IF NOT EXISTS audio_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_ms INTEGER,
    category VARCHAR(50) DEFAULT 'voiceover' CHECK (category IN ('voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music')),
    character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    transcription TEXT,
    transcription_status VARCHAR(50) DEFAULT 'pending' CHECK (transcription_status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
    transcription_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add columns if they don't exist (for existing databases)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_files' AND column_name = 'transcription') THEN
        ALTER TABLE audio_files ADD COLUMN transcription TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_files' AND column_name = 'transcription_status') THEN
        ALTER TABLE audio_files ADD COLUMN transcription_status VARCHAR(50) DEFAULT 'pending';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_files' AND column_name = 'transcription_error') THEN
        ALTER TABLE audio_files ADD COLUMN transcription_error TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_files' AND column_name = 'category') THEN
        ALTER TABLE audio_files ADD COLUMN category VARCHAR(50) DEFAULT 'voiceover';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_files' AND column_name = 'character_id') THEN
        ALTER TABLE audio_files ADD COLUMN character_id UUID REFERENCES characters(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Update category constraint to include music (for existing databases)
DO $$
BEGIN
    ALTER TABLE audio_files DROP CONSTRAINT IF EXISTS audio_files_category_check;
    ALTER TABLE audio_files ADD CONSTRAINT audio_files_category_check
        CHECK (category IN ('voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music'));
EXCEPTION WHEN others THEN
    NULL;
END $$;

-- Node audio assignments table
CREATE TABLE IF NOT EXISTS node_audio_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL,
    audio_type VARCHAR(50) NOT NULL CHECK (audio_type IN ('voiceover', 'ambience', 'sfx', 'choice1', 'choice2')),
    audio_file_id UUID NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, node_id, audio_type, audio_file_id)
);

-- Update constraint to include choice audio types (for existing databases)
DO $$
BEGIN
    ALTER TABLE node_audio_assignments DROP CONSTRAINT IF EXISTS node_audio_assignments_audio_type_check;
    ALTER TABLE node_audio_assignments ADD CONSTRAINT node_audio_assignments_audio_type_check
        CHECK (audio_type IN ('voiceover', 'ambience', 'sfx', 'choice1', 'choice2'));
EXCEPTION WHEN others THEN
    NULL;
END $$;

-- Node metadata table (transcripts, timing, settings)
CREATE TABLE IF NOT EXISTS node_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL,
    transcript TEXT,
    delay_before_ms INTEGER DEFAULT 0,
    delay_after_ms INTEGER DEFAULT 0,
    auto_advance BOOLEAN DEFAULT true,
    auto_advance_delay_ms INTEGER DEFAULT 2000,
    choice_1_timestamp_ms INTEGER DEFAULT NULL,
    choice_2_timestamp_ms INTEGER DEFAULT NULL,
    no_inline_choice_audio BOOLEAN DEFAULT false,
    character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, node_id)
);

-- Add choice timestamp columns if they don't exist (for existing databases)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_metadata' AND column_name = 'choice_1_timestamp_ms') THEN
        ALTER TABLE node_metadata ADD COLUMN choice_1_timestamp_ms INTEGER DEFAULT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_metadata' AND column_name = 'choice_2_timestamp_ms') THEN
        ALTER TABLE node_metadata ADD COLUMN choice_2_timestamp_ms INTEGER DEFAULT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_metadata' AND column_name = 'no_inline_choice_audio') THEN
        ALTER TABLE node_metadata ADD COLUMN no_inline_choice_audio BOOLEAN DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'node_metadata' AND column_name = 'character_id') THEN
        ALTER TABLE node_metadata ADD COLUMN character_id UUID REFERENCES characters(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Session table (for connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSONB NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session((sess->>'userId'));

-- Project collaborators table
CREATE TABLE IF NOT EXISTS project_collaborators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_collaborators_project_id ON project_collaborators(project_id);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_user_id ON project_collaborators(user_id);

-- Add owner_id column to projects if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'owner_id') THEN
        ALTER TABLE projects ADD COLUMN owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);

-- Project builds table
CREATE TABLE IF NOT EXISTS project_builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    build_number INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    label VARCHAR(255),
    total_size_bytes BIGINT,
    audio_size_bytes BIGINT,
    code_size_bytes BIGINT,
    audio_file_count INTEGER,
    node_count INTEGER,
    artifact_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(project_id, build_number)
);

CREATE INDEX IF NOT EXISTS idx_project_builds_project_id ON project_builds(project_id);
CREATE INDEX IF NOT EXISTS idx_project_builds_status ON project_builds(status);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_project_stories_project_id ON project_stories(project_id);
CREATE INDEX IF NOT EXISTS idx_project_settings_project_id ON project_settings(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audio_files_project_id ON audio_files(project_id);
CREATE INDEX IF NOT EXISTS idx_node_audio_assignments_project_id ON node_audio_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_node_audio_assignments_node_id ON node_audio_assignments(project_id, node_id);
CREATE INDEX IF NOT EXISTS idx_node_metadata_project_id ON node_metadata(project_id);
CREATE INDEX IF NOT EXISTS idx_node_metadata_node_id ON node_metadata(project_id, node_id);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers
DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_project_stories_updated_at ON project_stories;
CREATE TRIGGER update_project_stories_updated_at
    BEFORE UPDATE ON project_stories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_project_settings_updated_at ON project_settings;
CREATE TRIGGER update_project_settings_updated_at
    BEFORE UPDATE ON project_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_audio_files_updated_at ON audio_files;
CREATE TRIGGER update_audio_files_updated_at
    BEFORE UPDATE ON audio_files
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_node_audio_assignments_updated_at ON node_audio_assignments;
CREATE TRIGGER update_node_audio_assignments_updated_at
    BEFORE UPDATE ON node_audio_assignments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_node_metadata_updated_at ON node_metadata;
CREATE TRIGGER update_node_metadata_updated_at
    BEFORE UPDATE ON node_metadata
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
