const path = require("path");
const fs = require('fs');
const functions = require("../structs/functions.js");
const Profile = require('../model/profiles.js');
const User = require('../model/user.js');
const log = require('../structs/log.js');
const config = JSON.parse(fs.readFileSync("./Config/config.json").toString());
const express = require("express");
const app = express.Router();

// Utilisation directe de __dirname
const levelThresholdsAbove100 = fs.readFileSync(path.join(__dirname, '../responses/Ch1XP.txt'), 'utf-8')
  .split('\n')
  .reduce((acc, line) => {
    const match = line.match(/(\d+) -> \d+ = ([\d,]+) XP/);
    if (match) {
      const level = parseInt(match[1]);
      const xp = parseInt(match[2].replace(/,/g, ''));
      acc[level] = xp;
    }
    return acc;
  }, {});

const XP_PER_KILL = 25;
const XP_PER_CHEST = 50;
const XP_PER_WIN = 175;
const XP_PER_TEST = 100000000;

const variantsFilePath = path.join(__dirname, '../responses/variants.json');
const variants = JSON.parse(fs.readFileSync(variantsFilePath, 'utf8'));

const getVariantsForItem = (templateId) => {
  const lowerTemplateId = templateId.toLowerCase();
  const matchingVariant = variants.find(variant => variant.id.toLowerCase() === lowerTemplateId);
  return matchingVariant ? matchingVariant.variants : [];
};

const grantReward = async (accountId, level) => {
  const battlePass = JSON.parse(fs.readFileSync(path.join(__dirname, `../responses/Athena/BattlePass/Season9.json`), 'utf8'));

  const freeRewards = battlePass.freeRewards[level - 1] || {};
  const paidRewards = battlePass.paidRewards[level - 1] || {};

  const profile = await Profile.findOne({ accountId });

  if (!profile) {
    throw new Error('Profile not found.');
  }

  const athena = profile.profiles.athena;
  const common_core = profile.profiles.common_core;

  if (!athena.items) athena.items = {};
  if (!common_core.items) common_core.items = {};

  const giftBoxItemID = functions.MakeID();
  const giftBoxItem = {
    templateId: "GiftBox:gb_battlepass",
    attributes: {
      max_level_bonus: 0,
      fromAccountId: "",
      lootList: [],
      itemGifted: true
    },
    quantity: 1
  };

  const processReward = (reward, rewardType) => {
    for (let key in reward) {
      if (key === "Currency:MtxPurchase") {
        const amountToAdd = reward[key];
        if (common_core.items['Currency:MtxPurchased']) {
          common_core.items['Currency:MtxPurchased'].quantity += amountToAdd;
        } else {
          common_core.items['Currency:MtxPurchased'] = {
            templateId: 'Currency:MtxPurchased',
            quantity: amountToAdd
          };
        }
      } else if (!athena.items[key]) {
        const ID = functions.MakeID();
        const item = {
          templateId: key,
          attributes: {
            item_seen: false,
            variants: getVariantsForItem(key)
          },
          quantity: 1
        };
        athena.items[ID] = item;
        giftBoxItem.attributes.lootList.push({
          itemType: item.templateId,
          itemGuid: ID,
          itemProfile: "athena",
          quantity: 1
        });
      }
    }
  };

  processReward(freeRewards, 'free');

  if (profile.profiles.athena.stats.attributes.book_purchased) {
    processReward(paidRewards, 'paid');
  }

  if (giftBoxItem.attributes.lootList.length > 0) {
    common_core.items[giftBoxItemID] = giftBoxItem;

    const ApplyProfileChanges = [{
      changeType: "itemAdded",
      itemId: giftBoxItemID,
      item: common_core.items[giftBoxItemID]
    }];

    athena.rvn += 1;
    athena.commandRevision += 1;
    athena.updated = new Date().toISOString();
    common_core.rvn += 1;
    common_core.commandRevision += 1;
    common_core.updated = new Date().toISOString();

    await Profile.findOneAndUpdate({ accountId }, {
      $set: {
        'profiles.athena': athena,
        'profiles.common_core': common_core
      }
    }, { new: true });

    functions.sendXmppMessageToId({
      type: "com.epicgames.gift.received",
      payload: {},
      timestamp: new Date().toISOString()
    }, accountId);

    log.backend(`Rewards granted for level ${level}.`);
  } else {
    log.backend(`No items to grant for level ${level}, skipping gift.`);
  }
};

// Route pour ajouter de l'XP à un utilisateur
app.get("/api/addxp", async (req, res) => {
  const { apikey, username, reason } = req.query;

  if (!apikey || apikey !== config.Api.bApiKey) {
    return res.status(403).send('Forbidden: Invalid API key.');
  }

  if (!username) return res.status(400).send('No username provided.');
  if (!reason) return res.status(400).send('No reason provided.');

  const lowerUsername = username.toLowerCase();

  try {
    const user = await User.findOne({ username_lower: lowerUsername });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const profile = await Profile.findOne({ accountId: user.accountId });
    if (!profile) {
      return res.status(404).send('Profile not found.');
    }

    let xpToAdd;
    if (reason === "Kills") {
      xpToAdd = XP_PER_KILL;
    } else if (reason === "Chests") {
      xpToAdd = XP_PER_CHEST;
    } else if (reason === "Wins") {
      xpToAdd = XP_PER_WIN;
    } else {
      return res.status(400).send('Invalid reason provided.');
    }

    const currentLevel = profile.profiles.athena.stats.attributes.level;
    if (reason === "Kills") {
      xpToAdd += xpToAdd * (currentLevel * 0.1);
    } else if (reason === "Wins") {
      xpToAdd += xpToAdd * (currentLevel * 0.15);
    } else if (reason === "Chests") {
      xpToAdd += xpToAdd * (currentLevel * 1);
    }

    const multiplier = user.donator ? 1.5 : 1;
    xpToAdd = xpToAdd * multiplier;

    const newQuantity = profile.profiles.athena.stats.attributes.xp + xpToAdd;
    let levelThreshold = levelThresholdsAbove100[currentLevel] || 0;

    if (currentLevel >= 100) {
      return res.status(200).send('XP granting has been stopped at level 100.');
    }

    const xpDifference = newQuantity - levelThreshold;
    let updatedLevel = currentLevel;

    if (xpDifference >= 0) {
      // Passer au niveau suivant
      updatedLevel = currentLevel + 1;

      const updatedXP = xpDifference % levelThreshold;

      const levelUpdate = {
        $inc: {
          'profiles.athena.stats.attributes.level': 1,
          'profiles.athena.stats.attributes.book_level': 1, // Passer au niveau suivant du Battle Pass
          'profiles.athena.stats.attributes.accountLevel': 1,
        },
        $set: {
          'profiles.athena.stats.attributes.xp': updatedXP,
          'profiles.athena.stats.attributes.book_xp': 0 // Réinitialiser les étoiles de combat
        }
      };

      await Profile.findOneAndUpdate({ accountId: user.accountId }, levelUpdate);
      await grantReward(user.accountId, updatedLevel);
    } else {
      await Profile.findOneAndUpdate({ accountId: user.accountId }, {
        $inc: {
          'profiles.athena.stats.attributes.xp': xpToAdd,
          // Pas d'ajout de book_xp ici pour éviter l'ajout des étoiles de combat
        }
      });
    }

    log.backend(`${user.username} has received XP for ${reason}.`);

    const finalUpdatedProfile = await Profile.findOne({ accountId: user.accountId });
    const newLevel = finalUpdatedProfile.profiles.athena.stats.attributes.level;
    return res.status(200).json({
      status: 'success',
      message: 'XP added and level updated.',
      newLevel
    });

  } catch (error) {
    console.error(error);
    return res.status(500).send('Server error.');
  }
});

module.exports = app;