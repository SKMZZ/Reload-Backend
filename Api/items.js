const express = require("express");
const app = express.Router();
const User = require("../model/user.js");
const Profile = require("../model/profiles.js");
const fs = require("fs");
const uuid = require("uuid");
const config = JSON.parse(fs.readFileSync("./Config/config.json").toString());

app.get("/api/additem", async (req, res) => {
    const { apikey, username, cosmetics, reason } = req.query;

    if (!apikey || apikey !== config.Api.bApiKey) {
        return res.status(401).json({ code: "401", error: "Invalid or missing API key." });
    }
    if (!username) {
        return res.status(400).json({ code: "400", error: "Missing username." });
    }
    if (!cosmetics) {
        return res.status(400).json({ code: "400", error: "Missing cosmetics." });
    }
    if (!reason) {
        return res.status(400).json({ code: "400", error: "Missing reason." });
    }

    const validReasons = config.Api.reasons;

    if (!validReasons[reason]) {
        return res.status(400).json({ code: "400", error: `Invalid reason. Allowed values: ${Object.keys(validReasons).join(", ")}.` });
    }

    const apiusername = username.trim().toLowerCase();

    try {
        const user = await User.findOne({ username_lower: apiusername });

        if (!user) {
            return res.status(200).json({ message: "User not found." });
        }

        const profile = await Profile.findOne({ accountId: user.accountId });

        if (!profile) {
            return res.status(404).json({ code: "404", error: "Profile not found." });
        }

        const athenaProfile = profile.profiles["athena"];
        const commonCoreProfile = profile.profiles["common_core"];

        if (athenaProfile.items[cosmetics]) {
            return res.status(200).json({ message: "The user already owns this cosmetic." });
        }

        const cosmeticItemId = cosmetics;
        athenaProfile.items[cosmeticItemId] = {
            "templateId": cosmetics,
            "attributes": {
                "level": 1,
                "item_seen": false
            },
            "quantity": 1
        };

        const giftBoxId = uuid.v4();
        commonCoreProfile.items[giftBoxId] = {
            "templateId": `GiftBox:GB_MakeGood`,
            "attributes": {
                "fromAccountId": `[Administrator]`,
                "lootList": [
                    {
                        "itemType": cosmetics,
                        "itemGuid": cosmetics,
                        "quantity": 1
                    }
                ],
                "params": {
                    "userMessage": `Thanks for using reload backend!`
                },
                "giftedOn": new Date().toISOString()
            },
            "quantity": 1
        };

        athenaProfile.rvn += 1;
        athenaProfile.commandRevision += 1;
        athenaProfile.updated = new Date().toISOString();

        commonCoreProfile.rvn += 1;
        commonCoreProfile.commandRevision += 1;
        commonCoreProfile.updated = new Date().toISOString();

        await Profile.updateOne(
            { accountId: user.accountId },
            {
                $set: {
                    'profiles.athena': athenaProfile,
                    'profiles.common_core': commonCoreProfile
                }
            }
        );

        return res.status(200).json({
            message: `Successfully added the item '${cosmetics}' and a GiftBox to ${username}'s profile.`,
            profileRevision: athenaProfile.rvn,
            profileCommandRevision: athenaProfile.commandRevision,
            profileChanges: [
                {
                    changeType: "itemAdded",
                    itemId: cosmeticItemId,
                    templateId: cosmetics
                },
                {
                    changeType: "itemAdded",
                    itemId: giftBoxId,
                    templateId: "GiftBox:GB_MakeGood"
                }
            ]
        });

    } catch (err) {
        console.error("Server error:", err);
        return res.status(500).json({ code: "500", error: "Server error. Check console logs for more details." });
    }
});

module.exports = app;
