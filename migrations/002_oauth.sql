-- Sign in with Google or GitHub. Accounts created that way have no password,
-- and each provider identity (provider + its stable user id) links to one user.
ALTER TABLE users MODIFY password_hash VARCHAR(100) NULL;

CREATE TABLE oauth_accounts (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          INT UNSIGNED NOT NULL,
  provider         VARCHAR(20)  NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  email            VARCHAR(254) NOT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_oauth_identity (provider, provider_user_id),
  KEY ix_oauth_user (user_id),
  CONSTRAINT fk_oauth_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
