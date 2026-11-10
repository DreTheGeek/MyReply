-- Facebook Pages join Instagram as a connectable platform. A Page row stores
-- the Page id in "instagramId" (the column holds any platform's account id;
-- see docs/channels.md) and a Page access token in "accessToken".
ALTER TYPE "ChannelPlatform" ADD VALUE IF NOT EXISTS 'FACEBOOK';
